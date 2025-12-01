// orchestrator-api/src/index.js
import express from 'express';
import { createClient } from 'redis';
import pg from 'pg';
import axios from 'axios';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import * as metrics from './metrics.js';

const app = express();
app.use(express.json());

// Config
const JULES_API_KEY = process.env.JULES_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PORT = process.env.PORT || 3000;

// Initialize clients
const db = new pg.Pool({ connectionString: DATABASE_URL });
const redis = createClient({ url: REDIS_URL });
await redis.connect();

// Metrics Endpoint
app.get('/api/v1/metrics', async (req, res) => {
  res.set('Content-Type', metrics.registerContentType);
  res.end(await metrics.getMetrics());
});

// Jules API client
const julesClient = axios.create({
  baseURL: 'https://api.jules.google.com/v1',
  headers: { 'X-Goog-Api-Key': JULES_API_KEY }
});

// GitHub API client
const githubClient = axios.create({
  baseURL: 'https://api.github.com',
  headers: { 
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json'
  }
});

// WebSocket Setup
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Track connected clients
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Client connected');
  
  // Send initial stats
  sendStats(ws);
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected');
  });
});

// Broadcast to all clients
function broadcast(data) {
  clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(JSON.stringify(data));
    }
  });
}

// Send workflow updates via WebSocket
async function notifyWorkflowUpdate(workflowId, data) {
  broadcast({
    type: 'workflow_update',
    workflow_id: workflowId,
    data,
    timestamp: new Date().toISOString()
  });
}

// Update stats broadcast
async function sendStats(ws = null) {
  try {
    const stats = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'running') as running,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
      FROM workflow_instances
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);
    
    const data = {
      type: 'stats_update',
      data: stats.rows[0]
    };
    
    if (ws) {
      ws.send(JSON.stringify(data));
    } else {
      broadcast(data);
    }
  } catch (error) {
    console.error('Error sending stats:', error);
  }
}

// ===== WORKFLOW EXECUTION ENDPOINT =====
app.post('/api/v1/workflows/execute', async (req, res) => {
  const { template_name, context } = req.body;
  
  // Load template from DB
  const template = await db.query(
    'SELECT * FROM workflow_templates WHERE name = $1',
    [template_name]
  );
  
  if (!template.rows.length) {
    return res.status(404).json({ error: 'Template not found' });
  }
  
  const definition = template.rows[0].definition_json;
  
  // Create workflow instance
  const instance = await db.query(
    'INSERT INTO workflow_instances (template_id, status, context_json) VALUES ($1, $2, $3) RETURNING *',
    [template.rows[0].id, 'pending', JSON.stringify(context)]
  );
  
  const workflowId = instance.rows[0].id;
  
  // Publish to event bus for async processing
  await redis.publish('workflow:created', JSON.stringify({
    workflow_id: workflowId,
    template: definition,
    context
  }));
  
  res.json({
    workflow_id: workflowId, 
    status: 'pending',
    message: 'Workflow queued for execution'
  });
});

// ===== WORKFLOW STATUS ENDPOINT =====
app.get('/api/v1/workflows/:id', async (req, res) => {
  const { id } = req.params;
  
  const workflow = await db.query(
    'SELECT w.*, t.jules_task_id, t.pr_url FROM workflow_instances w LEFT JOIN jules_tasks t ON t.workflow_instance_id = w.id WHERE w.id = $1',
    [id]
  );
  
  if (!workflow.rows.length) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  
  res.json(workflow.rows[0]);
});

// ===== GITHUB WEBHOOK RECEIVER =====
app.post('/api/v1/webhooks/github', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;
  
  // Route to appropriate handler based on event type
  if (event === 'issues' && payload.action === 'labeled') {
    const label = payload.label.name;
    const repo = payload.repository.full_name;
    
    // Check if label matches any workflow trigger
    const template = await db.query(
      "SELECT * FROM workflow_templates WHERE definition_json->>'trigger'->>'label' = $1",
      [label]
    );
    
    if (template.rows.length) {
      // Execute workflow
      await redis.publish('workflow:created', JSON.stringify({
        template: template.rows[0].definition_json,
        context: {
          repo_name: repo,
          issue_title: payload.issue.title,
          issue_body: payload.issue.body,
          issue_number: payload.issue.number,
          trigger_issue_number: payload.issue.number
        }
      }));
    }
  }
  
  res.status(200).json({ received: true });
});

// ===== WORKFLOW PROCESSOR (Background Worker) =====
async function processWorkflow(message) {
  const { workflow_id, template, context } = JSON.parse(message);
  const timer = metrics.workflowDuration.startTimer({ template: template.name });
  
  try {
    // Update status
    await db.query('UPDATE workflow_instances SET status = $1 WHERE id = $2', ['running', workflow_id]);
    notifyWorkflowUpdate(workflow_id, { status: 'running' });
    metrics.activeWorkflows.inc();
    
    // Execute pre_actions
    if (template.pre_actions) {
      for (const action of template.pre_actions) {
        await executeAction(action, context, workflow_id);
      }
    }
    
    // Substitute template variables in task description
    const task = substituteVariables(template.task, context);
    
    // Create Jules task
    const julesResponse = await julesClient.post('/tasks', {
      repository: task.repo,
      title: task.title,
      description: task.description,
      labels: task.labels
    });
    
    const julesTaskId = julesResponse.data.id;
    metrics.julesTaskCounter.inc({ status: 'created' });
    
    // Store Jules task reference
    await db.query(
      'INSERT INTO jules_tasks (workflow_instance_id, jules_task_id, status) VALUES ($1, $2, $3)',
      [workflow_id, julesTaskId, 'created']
    );
    
    // Poll for Jules task completion (or set up webhook listener)
    pollJulesTask(workflow_id, julesTaskId, template, context, timer);
    
  } catch (error) {
    await db.query('UPDATE workflow_instances SET status = $1 WHERE id = $2', ['failed', workflow_id]);
    notifyWorkflowUpdate(workflow_id, { status: 'failed', error: error.message });
    console.error('Workflow execution failed:', error);
    metrics.workflowCounter.inc({ template: template.name, status: 'failed' });
    metrics.activeWorkflows.dec();
    timer({ status: 'failed' });
  }
}

// Subscribe to workflow events
redis.subscribe('workflow:created', processWorkflow);

// ===== HELPER FUNCTIONS =====
function substituteVariables(obj, context) {
  const json = JSON.stringify(obj);
  const substituted = json.replace(/\{\{(.+?)\}\}/g, (_, key) => context[key] || '');
  return JSON.parse(substituted);
}

async function executeAction(action, context, workflowId) {
  try {
      // Implementation for each action type
      if (action.type === 'notify' && action.target === 'slack') {
        // Send Slack notification
        if (process.env.SLACK_WEBHOOK_URL) {
            await axios.post(process.env.SLACK_WEBHOOK_URL, {
                text: substituteVariables({ text: action.message }, context).text
            });
        }
      } else if (action.type === 'github_comment') {
        // Post GitHub comment
        const [owner, repo] = context.repo_name.split('/');
        await githubClient.post(`/repos/${owner}/${repo}/issues/${context.issue_number}/comments`, {
          body: substituteVariables({ text: action.message }, context).text
        });
      }
      // ... implement other action types
      
      // Log action
      await db.query(
        'INSERT INTO action_log (workflow_instance_id, action_type, result) VALUES ($1, $2, $3)',
        [workflowId, action.type, 'success']
      );
      metrics.actionCounter.inc({ action_type: action.type, success: 'true' });
  } catch (e) {
      metrics.actionCounter.inc({ action_type: action.type, success: 'false' });
      throw e;
  }
}

async function pollJulesTask(workflowId, julesTaskId, template, context, timer) {
  const poll = setInterval(async () => {
    try {
      const status = await julesClient.get(`/tasks/${julesTaskId}`);
      const taskStatus = status.data.status;
      
      await db.query(
        'UPDATE jules_tasks SET status = $1, pr_url = $2 WHERE jules_task_id = $3',
        [taskStatus, status.data.pr_url, julesTaskId]
      );
      
      if (taskStatus === 'completed') {
        clearInterval(poll);
        
        // Execute post_actions
        if (template.post_actions) {
          for (const action of template.post_actions) {
            await executeAction(action, { ...context, pr_url: status.data.pr_url }, workflowId);
          }
        }
        
        await db.query('UPDATE workflow_instances SET status = $1 WHERE id = $2', ['completed', workflowId]);
        notifyWorkflowUpdate(workflowId, { status: 'completed', pr_url: status.data.pr_url });
        sendStats();
        
        metrics.workflowCounter.inc({ template: template.name, status: 'completed' });
        metrics.julesTaskCounter.inc({ status: 'completed' });
        metrics.activeWorkflows.dec();
        timer({ status: 'completed' });

      } else if (taskStatus === 'failed') {
        clearInterval(poll);
        await db.query('UPDATE workflow_instances SET status = $1 WHERE id = $2', ['failed', workflowId]);
        notifyWorkflowUpdate(workflowId, { status: 'failed' });
        
        metrics.workflowCounter.inc({ template: template.name, status: 'failed' });
        metrics.julesTaskCounter.inc({ status: 'failed' });
        metrics.activeWorkflows.dec();
        timer({ status: 'failed' });
      }
    } catch (error) {
      console.error('Error polling Jules task:', error);
    }
  }, 30000); // Poll every 30 seconds
}

// Start server
server.listen(PORT, () => {
  console.log(`Jules Orchestrator API with WebSocket running on port ${PORT}`);
});