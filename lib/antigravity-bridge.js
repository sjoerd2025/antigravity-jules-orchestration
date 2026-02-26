/**
 * Antigravity Bridge Module
 *
 * Bridge between MCP tools and Antigravity agents for browser automation,
 * code generation, and orchestrated development workflows.
 *
 * Provides:
 * - Agent lifecycle management (create, run, monitor, stop)
 * - Browser automation session coordination
 * - Code generation pipeline with Gemini integration
 * - Event-driven agent communication
 *
 * @module lib/antigravity-bridge
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/**
 * AgentBridge class — manages Antigravity agents and routes
 * MCP tool calls to the appropriate agent capabilities.
 */
export class AgentBridge extends EventEmitter {
  constructor(geminiClient, sessionManager) {
    super();
    this.geminiClient = geminiClient;
    this.sessionManager = sessionManager;
    this.agents = new Map();       // agentId -> agent state
    this.tasks = new Map();        // taskId  -> task state
    this.maxConcurrentAgents = 5;
  }

  // ─── Agent Lifecycle ────────────────────────────────────────

  /**
   * Register a new Antigravity agent definition.
   * @param {Object} agentDef - Agent definition (name, capabilities, config)
   * @returns {string} agentId
   */
  registerAgent(agentDef) {
    const agentId = agentDef.id || uuidv4();
    const agent = {
      id: agentId,
      name: agentDef.name || 'unnamed-agent',
      capabilities: agentDef.capabilities || [],
      config: agentDef.config || {},
      status: 'idle',
      createdAt: new Date().toISOString(),
      lastActivity: null,
      taskHistory: [],
    };

    this.agents.set(agentId, agent);
    this.emit('agent:registered', { agentId, name: agent.name });
    console.log(`[AgentBridge] Registered agent "${agent.name}" (${agentId})`);
    return agentId;
  }

  /**
   * Get an agent by ID.
   * @param {string} agentId
   * @returns {Object|null}
   */
  getAgent(agentId) {
    return this.agents.get(agentId) || null;
  }

  /**
   * List all registered agents.
   * @returns {Object[]}
   */
  listAgents() {
    return Array.from(this.agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      capabilities: a.capabilities,
      lastActivity: a.lastActivity,
    }));
  }

  /**
   * Remove an agent.
   * @param {string} agentId
   * @returns {boolean} true if removed
   */
  removeAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    if (agent.status === 'running') {
      console.warn(`[AgentBridge] Removing active agent "${agent.name}"`);
    }

    this.agents.delete(agentId);
    this.emit('agent:removed', { agentId });
    return true;
  }

  // ─── Task Execution ─────────────────────────────────────────

  /**
   * Dispatch a task to a specific agent or auto-route by capability.
   * @param {Object} taskDef - Task definition
   * @param {string} [taskDef.agentId] - Target agent (optional, auto-routes if missing)
   * @param {string} taskDef.type - Task type (e.g., 'code_generation', 'browser_automation', 'analysis')
   * @param {Object} taskDef.params - Task parameters
   * @returns {Promise<Object>} Task result
   */
  async dispatchTask(taskDef) {
    const taskId = uuidv4();
    const { agentId, type, params } = taskDef;

    // Find or auto-route agent
    let agent;
    if (agentId) {
      agent = this.agents.get(agentId);
      if (!agent) throw new Error(`Agent ${agentId} not found`);
    } else {
      agent = this._findAgentByCapability(type);
      if (!agent) throw new Error(`No agent available for capability: ${type}`);
    }

    // Create task state
    const task = {
      id: taskId,
      agentId: agent.id,
      type,
      params,
      status: 'pending',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };

    this.tasks.set(taskId, task);
    this.emit('task:created', { taskId, agentId: agent.id, type });

    try {
      // Update states
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      agent.status = 'running';
      agent.lastActivity = new Date().toISOString();

      // Execute based on task type
      const result = await this._executeTask(agent, task);

      // Success
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      task.result = result;
      agent.status = 'idle';
      agent.taskHistory.push({ taskId, type, status: 'completed', timestamp: task.completedAt });

      this.emit('task:completed', { taskId, agentId: agent.id, result });
      return { taskId, status: 'completed', result };

    } catch (error) {
      task.status = 'failed';
      task.completedAt = new Date().toISOString();
      task.error = error.message;
      agent.status = 'idle';
      agent.taskHistory.push({ taskId, type, status: 'failed', timestamp: task.completedAt });

      this.emit('task:failed', { taskId, agentId: agent.id, error: error.message });
      throw error;
    }
  }

  /**
   * Get task status.
   * @param {string} taskId
   * @returns {Object|null}
   */
  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * List tasks, optionally filtered by agent or status.
   * @param {Object} [filters]
   * @returns {Object[]}
   */
  listTasks(filters = {}) {
    let tasks = Array.from(this.tasks.values());
    if (filters.agentId) tasks = tasks.filter(t => t.agentId === filters.agentId);
    if (filters.status) tasks = tasks.filter(t => t.status === filters.status);
    if (filters.type) tasks = tasks.filter(t => t.type === filters.type);
    return tasks.map(t => ({
      id: t.id,
      agentId: t.agentId,
      type: t.type,
      status: t.status,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    }));
  }

  // ─── Internal Execution ─────────────────────────────────────

  /**
   * Route task execution to the appropriate handler.
   * @private
   */
  async _executeTask(agent, task) {
    switch (task.type) {
      case 'code_generation':
        return await this._handleCodeGeneration(agent, task);
      case 'code_analysis':
        return await this._handleCodeAnalysis(agent, task);
      case 'browser_automation':
        return await this._handleBrowserAutomation(agent, task);
      case 'gemini_chat':
        return await this._handleGeminiChat(agent, task);
      default:
        return await this._handleGenericTask(agent, task);
    }
  }

  /**
   * Generate code using Gemini.
   * @private
   */
  async _handleCodeGeneration(_agent, task) {
    const { prompt, language, context } = task.params;
    const fullPrompt = context
      ? `Context:\n${context}\n\nTask: Generate ${language || ''} code:\n${prompt}`
      : `Generate ${language || ''} code:\n${prompt}`;

    const result = await this.geminiClient.generateCode(fullPrompt, {
      language: language || 'javascript',
    });

    return {
      type: 'code_generation',
      code: result.code || result.text,
      language: language || 'javascript',
    };
  }

  /**
   * Analyze code using Gemini.
   * @private
   */
  async _handleCodeAnalysis(_agent, task) {
    const { code, language, analysisType } = task.params;
    const prompt = `Analyze the following ${language || ''} code for ${analysisType || 'quality, bugs, and improvements'}:\n\n\`\`\`${language || ''}\n${code}\n\`\`\``;

    const result = await this.geminiClient.geminiRequest('generate', {
      prompt,
    });

    return {
      type: 'code_analysis',
      analysis: result.text || result,
      analysisType: analysisType || 'general',
    };
  }

  /**
   * Placeholder for browser automation via Antigravity.
   * This will be expanded when the Antigravity browser agent API is available.
   * @private
   */
  async _handleBrowserAutomation(_agent, task) {
    const { url, actions, screenshot } = task.params;
    console.log(`[AgentBridge] Browser automation requested for: ${url}`);

    // Placeholder: browser automation will integrate with
    // Antigravity's browser agent when available
    return {
      type: 'browser_automation',
      url,
      status: 'simulated',
      message: 'Browser automation agent not yet connected. Task queued for future execution.',
      actions: actions || [],
      screenshot: screenshot || false,
    };
  }

  /**
   * Handle a Gemini chat interaction.
   * @private
   */
  async _handleGeminiChat(_agent, task) {
    const { message, sessionId, history } = task.params;

    // If a sessionId is provided, append to existing session
    if (sessionId) {
      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        this.sessionManager.updateStatus(sessionId, 'active');
      }
    }

    const result = await this.geminiClient.geminiRequest('generate', {
      prompt: message,
      history: history || [],
    });

    return {
      type: 'gemini_chat',
      response: result.text || result,
      sessionId: sessionId || null,
    };
  }

  /**
   * Handle unknown task types generically through Gemini.
   * @private
   */
  async _handleGenericTask(_agent, task) {
    const result = await this.geminiClient.geminiRequest('generate', {
      prompt: `Execute task of type "${task.type}" with parameters: ${JSON.stringify(task.params)}`,
    });

    return {
      type: task.type,
      response: result.text || result,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────

  /**
   * Find an agent that can handle the given capability.
   * @private
   */
  _findAgentByCapability(capability) {
    for (const agent of this.agents.values()) {
      if (agent.status === 'idle' && agent.capabilities.includes(capability)) {
        return agent;
      }
    }
    // Fallback: any idle agent
    for (const agent of this.agents.values()) {
      if (agent.status === 'idle') {
        return agent;
      }
    }
    return null;
  }

  /**
   * Get bridge statistics.
   * @returns {Object}
   */
  getStats() {
    const agents = Array.from(this.agents.values());
    const tasks = Array.from(this.tasks.values());

    return {
      agents: {
        total: agents.length,
        idle: agents.filter(a => a.status === 'idle').length,
        running: agents.filter(a => a.status === 'running').length,
      },
      tasks: {
        total: tasks.length,
        pending: tasks.filter(t => t.status === 'pending').length,
        running: tasks.filter(t => t.status === 'running').length,
        completed: tasks.filter(t => t.status === 'completed').length,
        failed: tasks.filter(t => t.status === 'failed').length,
      },
    };
  }
}

// ─── Default Instance Factory ───────────────────────────────

/**
 * Create an AgentBridge wired to the given Gemini client and session manager.
 * @param {Object} geminiClient - The Gemini API client module
 * @param {Object} sessionManager - The SessionManager instance
 * @returns {AgentBridge}
 */
export function createAgentBridge(geminiClient, sessionManager) {
  const bridge = new AgentBridge(geminiClient, sessionManager);

  // Register the default Gemini agent
  bridge.registerAgent({
    id: 'gemini-default',
    name: 'Gemini Default Agent',
    capabilities: ['code_generation', 'code_analysis', 'gemini_chat', 'generic'],
    config: { model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' },
  });

  return bridge;
}

export default { AgentBridge, createAgentBridge };
