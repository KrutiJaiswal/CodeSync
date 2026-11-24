export interface User {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
  githubUsername?: string;
  githubConnected?: boolean;
}

export interface RoomUser {
  id: string;
  name: string;
  color: string;
  isHost?: boolean;
  cursor?: {
    lineNumber: number;
    column: number;
  };
}

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  userName: string;
  userColor: string;
  content: string;
  timestamp: string;
  isSystem?: boolean;
}

export interface CodeRunResult {
  stdout: string | null;
  stderr: string | null;
  status?: {
    id: number;
    description: string;
  };
  time?: string | null;
  memory?: number | null;
  error?: string;
}

export interface LineOwner {
  userId: string;
  userName: string;
  userColor: string;
  timestamp: number;
}

export type SupportedLanguage = 
  | 'javascript'
  | 'python'
  | 'java'
  | 'c'
  | 'cpp'
  | 'typescript'
  | 'rust'
  | 'go';

export interface LanguageInfo {
  id: SupportedLanguage;
  name: string;
  extension: string;
  monacoLanguage: string;
  judge0Name: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
}
