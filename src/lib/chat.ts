export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
}

const labels: Record<string, string> = {
  inspect_board: 'Read board',
  get_position: 'Read board',
  get_context: 'Read coaching context',
  analyse_position: 'Analysed position',
  verify_claims: 'Checked coaching claims',
  publish_coaching: 'Prepared coaching',
  start_activity: 'Changed activity',
  set_activity: 'Changed activity',
  set_position: 'Changed position',
  play_move: 'Played move',
  set_opponent: 'Changed opponent',
  show_demonstration: 'Prepared example board',
  ask_question: 'Prepared question',
  write_player_note: 'Wrote coaching note',
  read_history: 'Read coaching notes',
  search_history: 'Searched coaching notes',
  propose_record_update: 'Proposed coaching note update',
  revise_prompt: 'Revised teaching prompt',
  propose_app_change: 'Proposed app improvement',
  record_intervention: 'Recorded assistance',
};

export function toolLabel(name: string): string {
  return labels[name] ?? name.replaceAll('_', ' ');
}
