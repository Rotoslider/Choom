import CodeExecutionHandler from '../skills/core/code-execution/handler';
import { REMOTE_SSH_DISABLED_MESSAGE } from '../lib/choom-permissions';
import type { SkillHandlerContext } from '../lib/skill-handler';
import type { ToolCall } from '../lib/types';

const deniedContext = {
  choom: { permissions: { ssh: false } },
} as unknown as SkillHandlerContext;

const sshCall: ToolCall = {
  id: 'ssh-denied-test',
  name: 'run_ssh_command',
  arguments: {
    target: 'developer@192.0.2.42',
    command: 'hostname',
  },
};

describe('run_ssh_command permission gate', () => {
  it('is registered by the code-execution skill', () => {
    expect(new CodeExecutionHandler().canHandle('run_ssh_command')).toBe(true);
  });

  it('denies a Choom without the explicit SSH grant before invoking OpenSSH', async () => {
    const result = await new CodeExecutionHandler().execute(sshCall, deniedContext);
    expect(result.error).toBe(REMOTE_SSH_DISABLED_MESSAGE);
  });
});
