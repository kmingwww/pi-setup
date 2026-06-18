import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWorker, runWorkerAsync } from '../../extensions/delegate-task/run-worker';
import { AgentManager } from '../../extensions/delegate-task/agent-manager';
import fs from 'fs/promises';
import os from 'os';

// ── Shared mocks ──
vi.mock('fs/promises');
vi.mock('os');
vi.mock('@earendil-works/pi-coding-agent', () => {
  class MockDefaultResourceLoader {
    async reload() { return; }
  }
  return {
    DefaultResourceLoader: MockDefaultResourceLoader,
    defineTool: vi.fn((def: any) => def),
    getAgentDir: vi.fn().mockReturnValue('/mock/agent/dir'),
    SessionManager: {
      create: vi.fn().mockReturnValue({})
    },
    createAgentSession: vi.fn().mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {}),
        agent: {
          state: {
            messages: [
              { role: 'assistant', content: [{ type: 'text', text: 'Final result text' }] }
            ]
          }
        }
      }
    })
  };
});

function setupMocks() {
  vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
  vi.spyOn(os, 'tmpdir').mockReturnValue('/tmp');
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
  vi.spyOn(fs, 'readFile').mockResolvedValue('---\ntools: ["read"]\n---\nmock body');
  vi.spyOn(fs, 'access').mockResolvedValue(undefined);
  vi.spyOn(process, 'cwd').mockReturnValue('/project');
}

async function setupSessionMock(result?: { messages: unknown[] }) {
  const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
  if (result) {
    vi.mocked(createAgentSession).mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {}),
        agent: { state: { messages: result.messages } }
      }
    } as any);
  } else {
    vi.mocked(createAgentSession).mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {}),
        agent: {
          state: {
            messages: [
              { role: 'assistant', content: [{ type: 'text', text: 'Final result text' }] }
            ]
          }
        }
      }
    } as any);
  }
}

// ── runWorker (sync) ──
describe('runWorker', () => {
  let manager: AgentManager;

  beforeEach(async () => {
    vi.resetAllMocks();
    manager = new AgentManager();
    setupMocks();
    await setupSessionMock();
  });

  it('spawns a child agent, runs task, and returns result', async () => {
    const mainSessionId = 'main-session-123';
    
    const result = await runWorker(
      'do some research',
      'researcher',
      'parent-id-1',
      mainSessionId,
      manager
    );

    expect(result).toBe('Final result text');
    expect(manager.getActiveCount()).toBe(0);
    
    const status = manager.getAgentStatuses('test-agent');
    expect(status).toContain('[DONE] researcher');
  });

  it('returns fallback message if result cannot be extracted', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {}),
        agent: { state: { messages: [] } }
      }
    } as any);

    const result = await runWorker('task', 'coder', null, 'main-123', manager);
    expect(result).toBe('Task completed, but no text output was generated.');
  });

  it('registers agent early so it is tracked even on failure', async () => {
    const registerSpy = vi.spyOn(manager, 'register');
    
    await runWorker('task', 'coder', 'parent', 'main-123', manager);
    
    expect(registerSpy).toHaveBeenCalled();
    const childId = registerSpy.mock.calls[0]![0];
    expect(childId).toMatch(/^agent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

// ── runWorkerAsync (fire-and-forget) ──
describe('runWorkerAsync', () => {
  let manager: AgentManager;
  let followUp: any;

  beforeEach(async () => {
    vi.resetAllMocks();
    manager = new AgentManager();
    followUp = vi.fn().mockResolvedValue(undefined);
    setupMocks();
    await setupSessionMock();
  });

  it('calls runWorker and sends followUp with result on success', async () => {
    const mainSessionId = 'main-session-123';
    
    // Deferred promise to track when followUp is called
    let followUpResolve: () => void;
    const followUpCalled = new Promise<void>((resolve) => {
      followUpResolve = resolve;
    });
    followUp.mockImplementation(async () => { followUpResolve(); });
    
    runWorkerAsync('do some research', 'researcher', 'parent-id-1', mainSessionId, manager, followUp);

    await followUpCalled;

    expect(followUp).toHaveBeenCalledTimes(1);
    const msg = followUp.mock.calls[0]![0];
    expect(msg).toMatch(/^✅ researcher done:/);
    expect(msg).toContain('Final result text');
  });

  it('registers and marks agent as done', async () => {
    const mainSessionId = 'main-session-123';
    const registerSpy = vi.spyOn(manager, 'register');
    
    let followUpResolve: () => void;
    const followUpCalled = new Promise<void>((resolve) => {
      followUpResolve = resolve;
    });
    followUp.mockImplementation(async () => { followUpResolve(); });
    
    runWorkerAsync('research', 'researcher', 'parent-id-1', mainSessionId, manager, followUp);
    await followUpCalled;

    expect(registerSpy).toHaveBeenCalled();
    const childId = registerSpy.mock.calls[0]![0];
    expect(childId).toMatch(/^agent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(manager.agents.get(childId)?.status).toBe('done');
  });

  it('catches errors from runWorker and sends followUp with error message', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    vi.mocked(createAgentSession).mockRejectedValueOnce(new Error('Network failure'));

    let followUpResolve: () => void;
    const followUpCalled = new Promise<void>((resolve) => {
      followUpResolve = resolve;
    });
    followUp.mockImplementation(async () => { followUpResolve(); });
    
    runWorkerAsync('research', 'researcher', 'parent', 'main-123', manager, followUp);
    await followUpCalled;

    expect(followUp).toHaveBeenCalledTimes(1);
    const msg = followUp.mock.calls[0]![0];
    expect(msg).toMatch(/^❌ researcher failed:/);
    expect(msg).toContain('Network failure');
  });

  it('marks agent as done even when worker crashes', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
    vi.mocked(createAgentSession).mockRejectedValueOnce(new Error('Network failure'));

    let followUpResolve: () => void;
    const followUpCalled = new Promise<void>((resolve) => {
      followUpResolve = resolve;
    });
    followUp.mockImplementation(async () => { followUpResolve(); });
    
    runWorkerAsync('research', 'researcher', 'parent', 'main-123', manager, followUp);
    await followUpCalled;

    expect(manager.getActiveCount()).toBe(0);
    const status = manager.getAgentStatuses('test-agent');
    expect(status).toContain('[DONE] researcher');
  });

  it('does not throw or propagate errors to the caller', () => {
    expect(() => {
      runWorkerAsync('research', 'researcher', 'parent', 'main-123', manager, followUp);
    }).not.toThrow();
  });
});
