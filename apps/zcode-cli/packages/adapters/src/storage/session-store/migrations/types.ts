export interface SqliteMigration {
  appVersion: string;
  id: string;
  sql: string;
}
