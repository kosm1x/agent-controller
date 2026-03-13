// Row types matching exact Supabase schema (derived from migrations)

export type HierarchyStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "on_hold";
export type Priority = "high" | "medium" | "low";
export type IdeaStatus = "draft" | "active" | "completed" | "archived";

export interface VisionRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: HierarchyStatus;
  target_date: string | null;
  order: number;
  created_at: string;
  updated_at: string;
  last_edited_at: string;
}

export interface GoalRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: HierarchyStatus;
  target_date: string | null;
  vision_id: string | null;
  order: number;
  created_at: string;
  updated_at: string;
  last_edited_at: string;
}

export interface ObjectiveRow {
  id: string;
  user_id: string;
  goal_id: string | null;
  title: string;
  description: string;
  status: HierarchyStatus;
  priority: Priority;
  target_date: string | null;
  order: number;
  created_at: string;
  updated_at: string;
  last_edited_at: string;
}

export interface TaskRow {
  id: string;
  user_id: string;
  objective_id: string | null;
  title: string;
  description: string;
  status: HierarchyStatus;
  priority: Priority;
  due_date: string | null;
  completed_at: string | null;
  order: number;
  notes: string;
  document_links: unknown[];
  is_recurring: boolean;
  created_at: string;
  updated_at: string;
  last_edited_at: string;
}

export interface TaskCompletionRow {
  id: string;
  task_id: string;
  user_id: string;
  completion_date: string;
  created_at: string;
}

export interface JournalEntryRow {
  id: string;
  user_id: string;
  content: string;
  entry_date: string;
  primary_emotion: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  initial_input: string;
  category: string;
  tags: unknown[];
  status: IdeaStatus;
  created_at: string;
  updated_at: string;
}

// Composite types for read tools

export interface DailySnapshot {
  date: string;
  vision: VisionRow | null;
  summary: {
    active_goals: number;
    active_objectives: number;
    pending_tasks: number;
    completed_today: number;
    streak_days: number;
  };
  overdue_tasks: TaskRow[];
  due_today: TaskRow[];
  in_progress: TaskRow[];
  recurring: {
    pending: TaskRow[];
    completed: TaskRow[];
  };
  upcoming_deadlines: TaskRow[];
  recent_journal: JournalEntryRow | null;
}

export interface TaskNode extends TaskRow {}

export interface ObjectiveNode extends ObjectiveRow {
  children: TaskNode[];
}

export interface GoalNode extends GoalRow {
  children: ObjectiveNode[];
}

export interface HierarchyNode extends VisionRow {
  children: GoalNode[];
}
