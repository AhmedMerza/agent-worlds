// Hook payloads recorded from Claude Code 2.1.296 (paths and ids genericised).
const base = { session_id: 'sess-1', transcript_path: '/tmp/t.jsonl', cwd: '/work/repo-a', prompt_id: 'p1', permission_mode: 'default' };
const bash = { command: 'touch hello.txt', description: 'Create hello.txt' };
const questions = [{ question: 'Do you prefer red or blue?', header: 'Color', options: [{ label: 'Red', description: 'You prefer red.' }, { label: 'Blue', description: 'You prefer blue.' }], multiSelect: false }];

export const ev = {
  start: { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-haiku' },
  prompt: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Run touch hello.txt\nthen ask me a colour' },
  preBash: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: bash, tool_use_id: 'toolu_1' },
  permBash: { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: bash, permission_suggestions: [{ type: 'addDirectories', directories: ['/work/repo-a'], destination: 'session' }] },
  notifyPerm: { ...base, hook_event_name: 'Notification', message: 'Claude needs your permission', notification_type: 'permission_prompt' },
  postBash: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: bash, tool_response: { stdout: '', stderr: '', interrupted: false }, tool_use_id: 'toolu_1', duration_ms: 762 },
  preAsk: { ...base, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'toolu_2' },
  permAsk: { ...base, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions } },
  postAsk: { ...base, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: { questions, answers: { 'Do you prefer red or blue?': 'Blue' }, annotations: {} }, tool_use_id: 'toolu_2' },
  stop: { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'ok\n\nI created `hello.txt` and you prefer blue.', background_tasks: [], session_crons: [] },
  preAgent: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Find callers of foo', prompt: 'find them', subagent_type: 'Explore' }, tool_use_id: 'toolu_3' },
  subStart: { ...base, hook_event_name: 'SubagentStart', agent_id: 'agent-9', agent_type: 'Explore' },
  subStop: { ...base, hook_event_name: 'SubagentStop', agent_id: 'agent-9', agent_type: 'Explore', last_assistant_message: 'found 3' },
  postAgent: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'Find callers of foo', prompt: 'find them', subagent_type: 'Explore' }, tool_response: {}, tool_use_id: 'toolu_3' },
  end: { ...base, hook_event_name: 'SessionEnd', reason: 'other' },
};

export const QUESTION = questions[0].question;
