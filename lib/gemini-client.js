/**
 * Gemini API Client
 * 
 * Google Gemini SDK integration for the orchestration server.
 * Preserves infrastructure patterns: circuit breaker, retry with exponential
 * backoff, structured logging, and request timeouts.
 * 
 * @module lib/gemini-client
 */

import { GoogleGenAI } from '@google/genai';
import { SessionManager } from './gemini-session.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

// ============================================================================
// STRUCTURED LOGGING (mirrors index.js pattern)
// ============================================================================

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, message, data = {}) {
  if (LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL]) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: 'gemini-client',
      message,
      ...data
    };
    console[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
  }
}

// ============================================================================
// CIRCUIT BREAKER (mirrors index.js pattern)
// ============================================================================

const circuitBreaker = {
  failures: 0,
  lastFailure: null,
  threshold: 5,
  resetTimeout: 60_000,

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      log('error', 'Circuit breaker OPEN — Gemini API temporarily unavailable', {
        failures: this.failures
      });
    }
  },

  recordSuccess() {
    this.failures = 0;
    this.lastFailure = null;
  },

  isOpen() {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.lastFailure > this.resetTimeout) {
      log('info', 'Circuit breaker HALF-OPEN — allowing test request');
      this.failures = this.threshold - 1; // allow one test request
      return false;
    }
    return true;
  },

  getStatus() {
    if (this.failures === 0) return 'closed';
    if (this.isOpen()) return 'open';
    return 'half-open';
  }
};

// ============================================================================
// GEMINI SDK INITIALIZATION
// ============================================================================

let genai = null;

function getClient() {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }
  if (!genai) {
    genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return genai;
}

// ============================================================================
// SESSION MANAGER (singleton)
// ============================================================================

const sessionManager = new SessionManager();

export { sessionManager };

// ============================================================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================================================

async function withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      circuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      lastError = error;
      circuitBreaker.recordFailure();

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 10_000);
        log('warn', `Retry attempt ${attempt + 1}/${maxRetries}`, {
          error: error.message,
          delayMs: delay
        });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ============================================================================
// TIMEOUT WRAPPER
// ============================================================================

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
    )
  ]);
}

// ============================================================================
// CORE API: geminiRequest
// ============================================================================

/**
 * Make a request to the Gemini API with circuit breaker + retry.
 * 
 * @param {'generateContent'|'chat'|'analyzeCode'} action - The type of request
 * @param {object} params - Request parameters
 * @returns {Promise<object>} The API response
 */
export async function geminiRequest(action, params = {}) {
  if (circuitBreaker.isOpen()) {
    throw new Error('Circuit breaker is open — Gemini API temporarily unavailable');
  }

  log('info', `Gemini API request: ${action}`, { model: params.model || GEMINI_MODEL });

  return withRetry(async () => {
    const client = getClient();
    const model = params.model || GEMINI_MODEL;

    switch (action) {
      case 'generateContent': {
        const result = await withTimeout(
          client.models.generateContent({
            model,
            contents: params.prompt,
            config: {
              temperature: params.temperature ?? 0.7,
              maxOutputTokens: params.maxOutputTokens ?? 8192,
            }
          })
        );
        return {
          text: result.text,
          model,
          usage: result.usageMetadata || null
        };
      }

      case 'chat': {
        const chat = client.chats.create({ model });
        const messages = params.messages || [];
        let lastResponse = null;

        for (const msg of messages) {
          if (msg.role === 'user') {
            lastResponse = await withTimeout(chat.sendMessage({ message: msg.content }));
          }
        }

        return {
          text: lastResponse?.text || '',
          model,
          messageCount: messages.length
        };
      }

      case 'analyzeCode': {
        const analysisPrompt = `Analyze the following code and provide:
1. A summary of what it does
2. Potential issues or bugs
3. Suggestions for improvement

Code:
\`\`\`
${params.code}
\`\`\`

${params.task ? `Specific focus: ${params.task}` : ''}`;

        const result = await withTimeout(
          client.models.generateContent({
            model,
            contents: analysisPrompt,
            config: { temperature: 0.3 }
          })
        );
        return {
          analysis: result.text,
          model
        };
      }

      default:
        throw new Error(`Unknown Gemini action: ${action}`);
    }
  });
}

// ============================================================================
// CORE API: generateCode
// ============================================================================

/**
 * Generate code using Gemini.
 * 
 * @param {string} prompt - The code generation prompt
 * @param {object} options - Options (model, language, context)
 * @returns {Promise<object>} Generated code response
 */
export async function generateCode(prompt, options = {}) {
  const systemPrompt = options.context
    ? `You are an expert software engineer. Generate clean, well-documented code.\n\nContext:\n${options.context}\n\nTask: ${prompt}`
    : `You are an expert software engineer. Generate clean, well-documented code.\n\nTask: ${prompt}`;

  if (options.language) {
    return geminiRequest('generateContent', {
      prompt: `${systemPrompt}\n\nLanguage: ${options.language}`,
      model: options.model,
      temperature: 0.4
    });
  }

  return geminiRequest('generateContent', {
    prompt: systemPrompt,
    model: options.model,
    temperature: 0.4
  });
}

// ============================================================================
// CORE API: createGeminiSession
// ============================================================================

/**
 * Create a new Gemini coding session.
 * Replaces createJulesSession() — generates code via Gemini and manages 
 * session state locally.
 * 
 * @param {object} config - Session configuration
 * @param {string} config.source - GitHub repository (owner/repo format)
 * @param {string} config.prompt - Task description
 * @param {string} [config.branch] - Target branch (default: 'main')
 * @param {string} [config.model] - Gemini model to use
 * @param {boolean} [config.autoApprove] - Auto-approve the plan
 * @returns {Promise<object>} Created session
 */
export async function createGeminiSession(config) {
  if (!config?.source) {
    throw new Error('source (repository) is required');
  }
  if (!config?.prompt) {
    throw new Error('prompt is required');
  }

  const session = sessionManager.create({
    repository: config.source,
    prompt: config.prompt,
    branch: config.branch || 'main',
    model: config.model || GEMINI_MODEL,
    autoApprove: config.autoApprove || false
  });

  log('info', 'Created Gemini session', { sessionId: session.id, repo: config.source });

  // Generate the implementation plan via Gemini
  try {
    sessionManager.updateStatus(session.id, 'running');

    const planResult = await geminiRequest('generateContent', {
      prompt: `You are an expert software engineer. Given the following task for repository "${config.source}" (branch: ${config.branch || 'main'}):

${config.prompt}

Generate a detailed implementation plan with:
1. Files to create/modify
2. Step-by-step changes
3. Test considerations

Be specific and actionable.`,
      model: config.model,
      temperature: 0.5
    });

    sessionManager.setResult(session.id, {
      plan: planResult.text,
      model: planResult.model,
      usage: planResult.usage
    });

    if (config.autoApprove) {
      sessionManager.updateStatus(session.id, 'completed');
    } else {
      sessionManager.updateStatus(session.id, 'awaiting_approval');
    }

    return sessionManager.get(session.id);
  } catch (error) {
    sessionManager.updateStatus(session.id, 'failed');
    sessionManager.setResult(session.id, { error: error.message });
    log('error', 'Session creation failed', { sessionId: session.id, error: error.message });
    throw error;
  }
}

// ============================================================================
// SESSION LIFECYCLE APIs
// ============================================================================

/**
 * List all Gemini sessions.
 */
export function listGeminiSessions(filters = {}) {
  return sessionManager.list(filters);
}

/**
 * Get a specific Gemini session by ID.
 */
export function getGeminiSession(id) {
  return sessionManager.get(id);
}

/**
 * Approve a pending Gemini session plan.
 */
export async function approveGeminiPlan(sessionId) {
  const session = sessionManager.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status !== 'awaiting_approval') {
    throw new Error(`Session ${sessionId} is not awaiting approval (status: ${session.status})`);
  }

  sessionManager.updateStatus(sessionId, 'running');

  try {
    // Execute the approved plan — generate the actual code
    const codeResult = await geminiRequest('generateContent', {
      prompt: `Based on this approved implementation plan, generate the complete code changes:

Plan:
${session.result?.plan || session.prompt}

Repository: ${session.repository}
Branch: ${session.branch}

Generate production-ready code with proper error handling and documentation.`,
      model: session.model,
      temperature: 0.3
    });

    sessionManager.setResult(sessionId, {
      ...session.result,
      code: codeResult.text,
      approvedAt: new Date().toISOString()
    });
    sessionManager.updateStatus(sessionId, 'completed');

    return sessionManager.get(sessionId);
  } catch (error) {
    sessionManager.updateStatus(sessionId, 'failed');
    throw error;
  }
}

// ============================================================================
// UTILITY: getGeminiStatus
// ============================================================================

/**
 * Get the overall status of the Gemini integration.
 */
export function getGeminiStatus() {
  return {
    configured: !!GEMINI_API_KEY,
    model: GEMINI_MODEL,
    circuitBreaker: circuitBreaker.getStatus(),
    sessions: sessionManager.getStats()
  };
}

// ============================================================================
// UTILITY: getCircuitBreakerStatus (for health checks)
// ============================================================================

export function getCircuitBreakerStatus() {
  return circuitBreaker.getStatus();
}
