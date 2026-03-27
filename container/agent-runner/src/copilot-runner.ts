/**
 * Copilot SDK Runner for NanoClaw
 * Alternative backend that uses @github/copilot-sdk instead of Claude Agent SDK.
 * Activated by AGENT_BACKEND=copilot environment variable.
 *
 * Implements the same interface as the Claude query logic in index.ts:
 * - Reads ContainerInput from stdin
 * - Runs agent via CopilotClient + CopilotSession
 * - Polls IPC for follow-up messages and close sentinel
 * - Writes ContainerOutput via stdout markers
 */

import fs from 'fs';
import path from 'path';
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type { SessionConfig, ResumeSessionConfig, MCPLocalServerConfig } from '@github/copilot-sdk';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[copilot-runner] ${message}`);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Build the base session config shared between create and resume.
 */
function buildSessionConfig(
  containerInput: ContainerInput,
  mcpServerPath: string,
): Pick<SessionConfig, 'model' | 'workingDirectory' | 'systemMessage' | 'mcpServers' | 'onPermissionRequest' | 'availableTools' | 'streaming'> {
  // Load global CLAUDE.md as additional system context
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let systemContent = '';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    systemContent = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Load group CLAUDE.md
  const groupClaudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMdPath)) {
    const groupContent = fs.readFileSync(groupClaudeMdPath, 'utf-8');
    systemContent = systemContent ? `${systemContent}\n\n${groupContent}` : groupContent;
  }

  const mcpConfig: MCPLocalServerConfig = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
    tools: ['*'],
  };

  const model = process.env.COPILOT_MODEL || 'claude-sonnet-4.5';

  return {
    model,
    workingDirectory: '/workspace/group',
    systemMessage: systemContent
      ? { content: systemContent }
      : undefined,
    mcpServers: {
      nanoclaw: mcpConfig,
    },
    onPermissionRequest: approveAll,
    availableTools: [
      'Bash',
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'mcp__nanoclaw__*',
    ],
    streaming: false,
  };
}

/**
 * Run a single query using the Copilot SDK.
 * Sends the prompt, waits for idle, polls IPC during execution.
 * Returns the session so the caller can reuse or disconnect it.
 */
async function runCopilotQuery(
  client: CopilotClient,
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  existingSession?: Awaited<ReturnType<CopilotClient['createSession']>>,
): Promise<{ session: Awaited<ReturnType<CopilotClient['createSession']>>; newSessionId?: string; closedDuringQuery: boolean }> {
  const config = buildSessionConfig(containerInput, mcpServerPath);

  let session = existingSession;
  if (!session) {
    if (sessionId) {
      log(`Resuming session: ${sessionId}`);
      const resumeConfig: ResumeSessionConfig = {
        model: config.model,
        workingDirectory: config.workingDirectory,
        systemMessage: config.systemMessage,
        mcpServers: config.mcpServers,
        onPermissionRequest: config.onPermissionRequest,
        availableTools: config.availableTools,
        streaming: config.streaming,
      };
      session = await client.resumeSession(sessionId, resumeConfig);
    } else {
      log('Creating new session');
      session = await client.createSession(config as SessionConfig);
    }
  }

  const newSessionId = session.sessionId;
  log(`Session ID: ${newSessionId}`);

  let closedDuringQuery = false;
  let ipcPolling = true;

  // Poll IPC for follow-up messages during execution
  const pollIpc = async () => {
    while (ipcPolling) {
      await new Promise(r => setTimeout(r, IPC_POLL_MS));
      if (!ipcPolling) break;

      if (shouldClose()) {
        log('Close sentinel detected during query');
        closedDuringQuery = true;
        ipcPolling = false;
        try { await session.abort(); } catch { /* ignore abort errors */ }
        break;
      }

      const messages = drainIpcInput();
      for (const text of messages) {
        log(`Sending IPC follow-up message (${text.length} chars)`);
        try {
          await session.send({ prompt: text });
        } catch (err) {
          log(`Failed to send follow-up: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  };

  // Start IPC polling in background
  const ipcPromise = pollIpc();

  // Send the prompt and wait for the response
  let resultText: string | null = null;
  try {
    const response = await session.sendAndWait({ prompt });
    if (response?.data?.content) {
      resultText = response.data.content;
      log(`Got response: ${resultText.slice(0, 200)}`);
    }
  } catch (err) {
    if (!closedDuringQuery) {
      throw err;
    }
    log('Query aborted due to close sentinel');
  }

  ipcPolling = false;
  await ipcPromise;

  writeOutput({
    status: 'success',
    result: resultText,
    newSessionId,
  });

  return { session, newSessionId, closedDuringQuery };
}

export async function runCopilotBackend(
  containerInput: ContainerInput,
  mcpServerPath: string,
  initialPrompt: string,
): Promise<void> {
  // Auth: uses stored OAuth credentials from ~/.copilot/ which is mounted read-only
  // from the host into /home/node/.copilot/ inside the container.
  // Run `copilot login` once on the server to populate it.
  const client = new CopilotClient({
    useStdio: true,
    logLevel: 'warning',
  });

  try {
    await client.start();
    log('Copilot client started');

    let sessionId = containerInput.sessionId;
    let prompt = initialPrompt;
    let currentSession: Awaited<ReturnType<CopilotClient['createSession']>> | undefined;

    // Query loop: run query → wait for IPC message → run new query → repeat
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const result = await runCopilotQuery(
        client,
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        currentSession,
      );

      currentSession = result.session;
      if (result.newSessionId) {
        sessionId = result.newSessionId;
      }

      if (result.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }

    // Disconnect session before stopping client
    if (currentSession) {
      try {
        await currentSession.disconnect();
        log('Session disconnected');
      } catch (err) {
        log(`Error disconnecting session: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    try {
      await client.stop();
      log('Copilot client stopped');
    } catch (err) {
      log(`Error stopping client: ${err instanceof Error ? err.message : String(err)}`);
      try { await client.forceStop(); } catch { /* last resort */ }
    }
  }
}
