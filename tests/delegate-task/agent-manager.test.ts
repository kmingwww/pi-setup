import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentManager, parseAgentFile, findAgentFile } from '../../extensions/delegate-task/agent-manager';
import fs from 'fs/promises';
import os from 'os';

vi.mock('fs/promises');
vi.mock('os');

describe('AgentManager', () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager();
  });

  it('aborts all running sessions on abortAll', async () => {
    const mockSession1 = { abort: vi.fn().mockResolvedValue(undefined) } as any;
    const mockSession2 = { abort: vi.fn().mockResolvedValue(undefined) } as any;
    
    manager.register('id-1', null, 'coder', 'task 1', mockSession1);
    manager.register('id-2', null, 'coder', 'task 2', mockSession2);
    
    manager.markDone('id-2', 'done'); // id-2 is done, should not be aborted
    
    await manager.abortAll();
    
    expect(mockSession1.abort).toHaveBeenCalled();
    expect(mockSession2.abort).not.toHaveBeenCalled();
  });

  it('registers a root agent at depth 1', () => {
    const depth = manager.register('root-id', null, 'coder', 'do some work');
    expect(depth).toBe(1);
    expect(manager.agents.get('root-id')).toMatchObject({
      parentId: null,
      depth: 1,
      status: 'running',
      agentType: 'coder',
      task: 'do some work'
    });
  });

  it('tracks depth hierarchically', () => {
    manager.register('root-id', null, 'coder', 'task 1');
    const childDepth = manager.register('child-id', 'root-id', 'researcher', 'task 2');
    expect(childDepth).toBe(2);
  });

  it('throws an error if max depth of 5 is exceeded', () => {
    manager.register('id-1', null, 'coder', 'task');
    manager.register('id-2', 'id-1', 'coder', 'task');
    manager.register('id-3', 'id-2', 'coder', 'task');
    manager.register('id-4', 'id-3', 'coder', 'task');
    manager.register('id-5', 'id-4', 'coder', 'task'); // Depth 5

    expect(() => {
      manager.register('id-6', 'id-5', 'coder', 'task'); // Depth 6
    }).toThrow('Max agent depth (5) exceeded.');
  });

  it('marks an agent as done and frees the session memory', () => {
    manager.register('id-1', null, 'coder', 'task', { mockSession: true } as any);
    manager.markDone('id-1', 'Success!');
    
    const agent = manager.agents.get('id-1');
    expect(agent?.status).toBe('done');
    expect(agent?.result).toBe('Success!');
    expect(agent?.session).toBeUndefined();
  });

  it('formats the team status correctly', () => {
    manager.register('id-1', null, 'manager', 'coordinate team');
    manager.register('id-2', 'id-1', 'researcher', 'find docs');
    manager.markDone('id-2', 'docs found');

    const status = manager.getAgentStatuses('test-agent');
    expect(status).toContain('TEAM ACTIVITY:');
    expect(status).toContain('- [RUNNING] manager (id-1)');
    expect(status).toContain('Task: coordinate team');
    expect(status).toContain('- [DONE] researcher (id-2)');
    expect(status).toContain('Task: find docs');
  });
});

describe('parseAgentFile', () => {
  it('extracts tools from frontmatter and returns the markdown body', () => {
    const content = `---
tools: ["read", "write"]
---
# Agent Context
You are a helpful assistant.`;

    const result = parseAgentFile(content);
    expect(result.tools).toEqual(['read', 'write']);
    expect(result.body).toBe('# Agent Context\nYou are a helpful assistant.');
  });

  it('returns undefined tools and the full body if no frontmatter is present', () => {
    const content = `# Agent Context\nYou are a helpful assistant.`;
    const result = parseAgentFile(content);
    expect(result.tools).toBeUndefined();
    expect(result.body).toBe('# Agent Context\nYou are a helpful assistant.');
  });
});

describe('findAgentFile', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('finds local legacy file first', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
    vi.spyOn(process, 'cwd').mockReturnValue('/project');
    
    // Make access succeed for the first path
    vi.spyOn(fs, 'access').mockImplementation(async (p: any) => {
      if (p.includes('.agent/agents/coder.md')) return undefined;
      throw new Error('Not found');
    });

    const result = await findAgentFile('coder');
    expect(result).toBe('/project/.agent/agents/coder.md');
  });

  it('falls back to local .pi path', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
    vi.spyOn(process, 'cwd').mockReturnValue('/project');
    
    vi.spyOn(fs, 'access').mockImplementation(async (p: any) => {
      if (p.includes('.pi/agents/coder.md') && p.includes('/project')) return undefined;
      throw new Error('Not found');
    });

    const result = await findAgentFile('coder');
    expect(result).toBe('/project/.pi/agents/coder.md');
  });

  it('falls back to global .pi path', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
    vi.spyOn(process, 'cwd').mockReturnValue('/project');
    
    vi.spyOn(fs, 'access').mockImplementation(async (p: any) => {
      if (p.includes('/home/user/.pi/agents/coder.md')) return undefined;
      throw new Error('Not found');
    });

    const result = await findAgentFile('coder');
    expect(result).toBe('/home/user/.pi/agents/coder.md');
  });

  it('returns null if no file is found', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
    vi.spyOn(process, 'cwd').mockReturnValue('/project');
    
    vi.spyOn(fs, 'access').mockRejectedValue(new Error('Not found'));

    const result = await findAgentFile('coder');
    expect(result).toBeNull();
  });
});
