export interface PaneInfo {
  id: string;
  cwd: string;
  label: string;
  character: string;
}

export interface AppInfo {
  myadePort: number;
  panes: PaneInfo[];
}

export interface CharacterInfo {
  id: string;
  name: string;
  color: string;
  iconDataUri: string | null;
}

export interface CompanionEventPayload {
  characterId: string;
  raw: any;
}

export interface CompanionTurnDonePayload {
  characterId: string;
  isError: boolean;
  finalText: string | null;
}
