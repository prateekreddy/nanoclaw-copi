/**
 * Copilot Device Auth
 * Called at startup when AGENT_BACKEND=copilot.
 * Checks if credentials exist in ~/.copilot/ and runs `copilot login`
 * (OAuth device flow) if not. Blocks until auth completes.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

// Looks for any JSON credential file the Copilot CLI would write
function hasStoredCredentials(): boolean {
  const configDir =
    process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  if (!fs.existsSync(configDir)) return false;
  const entries = fs.readdirSync(configDir).filter((f) => f.endsWith('.json'));
  return entries.length > 0;
}

/**
 * Find the `copilot` CLI. Prefers globally installed binary; falls back to
 * the local npm-loader.js inside the container/agent-runner deps.
 */
function findCopilotCli(): { cmd: string; args: string[] } {
  const localLoaders = [
    path.join(
      process.cwd(),
      'container',
      'agent-runner',
      'node_modules',
      '@github',
      'copilot',
      'npm-loader.js',
    ),
    path.join(
      process.cwd(),
      'node_modules',
      '@github',
      'copilot',
      'npm-loader.js',
    ),
  ];

  for (const loaderPath of localLoaders) {
    if (fs.existsSync(loaderPath)) {
      return { cmd: process.execPath, args: [loaderPath, 'login'] };
    }
  }

  // Fall back to globally installed `copilot` binary in PATH
  return { cmd: 'copilot', args: ['login'] };
}

/**
 * Run `copilot login` using the OAuth device flow.
 * Streams output directly to stdout/stderr so the user sees the code + URL.
 * Resolves when the process exits 0 (auth succeeded).
 */
export async function ensureCopilotAuth(): Promise<void> {
  if (hasStoredCredentials()) {
    logger.info('Copilot credentials found — skipping login');
    return;
  }

  const { cmd, args } = findCopilotCli();

  logger.info(
    'No Copilot credentials found — starting device auth flow.\n' +
      'A code will appear below. Visit https://github.com/login/device on your phone and enter it.',
  );

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: 'inherit', // stream device code + URL straight to the terminal
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        logger.info('Copilot auth completed — starting NanoClaw');
        resolve();
      } else {
        reject(
          new Error(
            `copilot login exited with code ${code}. Restart nanoclaw to try again.`,
          ),
        );
      }
    });
    proc.on('error', reject);
  });
}
