/**
 * GoalGraph — Directed acyclic graph of goals with dependency tracking.
 *
 * Manages goal lifecycle: add, remove, status updates, dependency-ordered
 * retrieval, cycle detection (Kahn's algorithm), and serialization.
 */

import { GoalStatus } from "./types.js";
import type { Goal } from "./types.js";

export interface AddGoalParams {
  description: string;
  id?: string;
  dependsOn?: string[];
  parentId?: string | null;
  completionCriteria?: string[];
  metadata?: Record<string, unknown>;
  status?: GoalStatus;
}

export class GoalGraph {
  private goals = new Map<string, Goal>();
  private nextId = 1;

  /** Number of goals in the graph. */
  get size(): number {
    return this.goals.size;
  }

  /** Generate a unique goal ID. */
  private generateId(): string {
    while (this.goals.has(`g-${this.nextId}`)) {
      this.nextId++;
    }
    return `g-${this.nextId++}`;
  }

  /** Add a goal to the graph. Returns the created goal. */
  addGoal(params: AddGoalParams): Goal {
    const id = params.id ?? this.generateId();

    if (this.goals.has(id)) {
      throw new Error(`Goal ${id} already exists`);
    }

    // Validate parent exists
    if (params.parentId && !this.goals.has(params.parentId)) {
      throw new Error(
        `Parent goal ${params.parentId} not found for goal ${id}`,
      );
    }

    // Validate dependencies exist
    for (const depId of params.dependsOn ?? []) {
      if (!this.goals.has(depId)) {
        throw new Error(`Dependency ${depId} not found for goal ${id}`);
      }
    }

    const now = new Date().toISOString();
    const goal: Goal = {
      id,
      description: params.description,
      status: params.status ?? GoalStatus.PENDING,
      completionCriteria: params.completionCriteria ?? [],
      parentId: params.parentId ?? null,
      dependsOn: [...(params.dependsOn ?? [])],
      children: [],
      metadata: { ...(params.metadata ?? {}) },
      createdAt: now,
      updatedAt: now,
    };

    this.goals.set(id, goal);

    // Wire parent → child
    if (goal.parentId) {
      const parent = this.goals.get(goal.parentId)!;
      parent.children.push(id);
    }

    return goal;
  }

  /** Remove a goal, cleaning up parent/child/dependency references. */
  removeGoal(goalId: string): Goal {
    const goal = this.getGoal(goalId);

    // Detach from parent
    if (goal.parentId) {
      const parent = this.goals.get(goal.parentId);
      if (parent) {
        parent.children = parent.children.filter((c) => c !== goalId);
      }
    }

    // Re-parent children to this goal's parent
    for (const childId of goal.children) {
      const child = this.goals.get(childId);
      if (child) {
        child.parentId = goal.parentId;
        if (goal.parentId) {
          const newParent = this.goals.get(goal.parentId);
          if (newParent && !newParent.children.includes(childId)) {
            newParent.children.push(childId);
          }
        }
      }
    }

    // Remove from others' dependsOn lists
    for (const [, other] of this.goals) {
      other.dependsOn = other.dependsOn.filter((d) => d !== goalId);
    }

    this.goals.delete(goalId);
    return goal;
  }

  /** Get a goal by ID. Throws if not found. */
  getGoal(goalId: string): Goal {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`Goal ${goalId} not found`);
    return goal;
  }

  /** Get a goal by ID, or undefined if not found. */
  findGoal(goalId: string): Goal | undefined {
    return this.goals.get(goalId);
  }

  /** Update a goal's status. */
  updateStatus(goalId: string, status: GoalStatus): void {
    const goal = this.getGoal(goalId);
    goal.status = status;
    goal.updatedAt = new Date().toISOString();
  }

  /** Get goals ready to execute: pending with all dependencies completed. */
  getReady(): Goal[] {
    const ready: Goal[] = [];
    for (const [, goal] of this.goals) {
      if (goal.status !== GoalStatus.PENDING) continue;
      const allDepsCompleted = goal.dependsOn.every((depId) => {
        const dep = this.goals.get(depId);
        return dep?.status === GoalStatus.COMPLETED;
      });
      if (allDepsCompleted) ready.push(goal);
    }
    return ready;
  }

  /** Get goals that are blocked (have failed or incomplete dependencies). */
  getBlocked(): Goal[] {
    const blocked: Goal[] = [];
    for (const [, goal] of this.goals) {
      if (
        goal.status !== GoalStatus.PENDING &&
        goal.status !== GoalStatus.BLOCKED
      )
        continue;
      const hasFailedDep = goal.dependsOn.some((depId) => {
        const dep = this.goals.get(depId);
        return dep?.status === GoalStatus.FAILED;
      });
      if (hasFailedDep) {
        goal.status = GoalStatus.BLOCKED;
        blocked.push(goal);
      }
    }
    return blocked;
  }

  /** Get all transitive dependents of a goal (goals that depend on it, recursively). */
  getDependents(goalId: string): string[] {
    this.getGoal(goalId); // validate exists
    const dependents: string[] = [];
    const visited = new Set<string>();
    const queue = [goalId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [, goal] of this.goals) {
        if (goal.dependsOn.includes(current) && !visited.has(goal.id)) {
          visited.add(goal.id);
          dependents.push(goal.id);
          queue.push(goal.id);
        }
      }
    }
    return dependents;
  }

  /** Get goals matching a status filter. */
  getByStatus(status: GoalStatus): Goal[] {
    const result: Goal[] = [];
    for (const [, goal] of this.goals) {
      if (goal.status === status) result.push(goal);
    }
    return result;
  }

  /** Status counts: { pending, in_progress, completed, blocked, failed, total }. */
  summary(): Record<string, number> {
    const counts: Record<string, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      blocked: 0,
      failed: 0,
      total: 0,
    };
    for (const [, goal] of this.goals) {
      counts[goal.status] = (counts[goal.status] ?? 0) + 1;
      counts.total++;
    }
    return counts;
  }

  /**
   * Validate the graph structure. Returns error strings (empty = valid).
   * Checks: cycle detection (Kahn's algorithm), orphan parents, dangling deps.
   */
  validate(): string[] {
    const errors: string[] = [];

    // Check orphan parent references
    for (const [, goal] of this.goals) {
      if (goal.parentId && !this.goals.has(goal.parentId)) {
        errors.push(
          `Goal ${goal.id} references missing parent ${goal.parentId}`,
        );
      }
      for (const depId of goal.dependsOn) {
        if (!this.goals.has(depId)) {
          errors.push(`Goal ${goal.id} depends on missing goal ${depId}`);
        }
      }
    }

    // Cycle detection via Kahn's algorithm
    const inDegree = new Map<string, number>();
    for (const [id] of this.goals) inDegree.set(id, 0);

    for (const [, goal] of this.goals) {
      for (const depId of goal.dependsOn) {
        if (inDegree.has(depId)) {
          // depId → goal.id edge: goal depends on depId
          inDegree.set(goal.id, (inDegree.get(goal.id) ?? 0) + 1);
        }
      }
    }

    // Re-count in-degree correctly: for each goal, its in-degree = number of its dependsOn entries
    for (const [id, goal] of this.goals) {
      let deg = 0;
      for (const depId of goal.dependsOn) {
        if (this.goals.has(depId)) deg++;
      }
      inDegree.set(id, deg);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    let processed = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      processed++;
      // Find goals that depend on current
      for (const [, goal] of this.goals) {
        if (goal.dependsOn.includes(current)) {
          const newDeg = (inDegree.get(goal.id) ?? 1) - 1;
          inDegree.set(goal.id, newDeg);
          if (newDeg === 0) queue.push(goal.id);
        }
      }
    }

    if (processed < this.goals.size) {
      errors.push(
        `Cycle detected: ${this.goals.size - processed} goals are part of a dependency cycle`,
      );
    }

    return errors;
  }

  /** Get all goals (direct reference, no copy). Use for read-only iteration. */
  getAll(): Goal[] {
    return Array.from(this.goals.values());
  }

  /** Serialize to plain object. */
  toJSON(): { goals: Record<string, Goal> } {
    const goals: Record<string, Goal> = {};
    for (const [id, goal] of this.goals) {
      goals[id] = { ...goal };
    }
    return { goals };
  }

  /** Deserialize from plain object. */
  static fromJSON(data: { goals: Record<string, Goal> }): GoalGraph {
    const graph = new GoalGraph();
    const goalEntries = Object.values(data.goals);

    // Topological insertion: add goals with no unresolvable deps first
    const added = new Set<string>();
    const remaining = [...goalEntries];
    let maxPasses = remaining.length + 1;

    while (remaining.length > 0 && maxPasses-- > 0) {
      const stillRemaining: Goal[] = [];

      for (const goal of remaining) {
        // Check if all dependencies are already added
        const depsReady = goal.dependsOn.every(
          (d) => added.has(d) || !goalEntries.some((g) => g.id === d),
        );
        const parentReady =
          !goal.parentId ||
          added.has(goal.parentId) ||
          !goalEntries.some((g) => g.id === goal.parentId);

        if (depsReady && parentReady) {
          // Filter out unresolvable references
          const validDeps = goal.dependsOn.filter((d) => added.has(d));
          const validParent =
            goal.parentId && added.has(goal.parentId) ? goal.parentId : null;

          if (validDeps.length !== goal.dependsOn.length) {
            console.warn(
              `[goal-graph] Goal ${goal.id}: dropped unresolvable deps ${goal.dependsOn.filter((d) => !added.has(d)).join(", ")}`,
            );
          }

          graph.addGoal({
            id: goal.id,
            description: goal.description,
            dependsOn: validDeps,
            parentId: validParent,
            completionCriteria: goal.completionCriteria,
            metadata: goal.metadata,
            status: goal.status,
          });
          added.add(goal.id);
        } else {
          stillRemaining.push(goal);
        }
      }

      if (stillRemaining.length === remaining.length) {
        // No progress — force-add remaining with cleaned refs
        for (const goal of stillRemaining) {
          const validDeps = goal.dependsOn.filter((d) => added.has(d));
          const validParent =
            goal.parentId && added.has(goal.parentId) ? goal.parentId : null;
          console.warn(
            `[goal-graph] Goal ${goal.id}: force-added with cleaned references`,
          );
          graph.addGoal({
            id: goal.id,
            description: goal.description,
            dependsOn: validDeps,
            parentId: validParent,
            completionCriteria: goal.completionCriteria,
            metadata: goal.metadata,
            status: goal.status,
          });
          added.add(goal.id);
        }
        break;
      }

      remaining.length = 0;
      remaining.push(...stillRemaining);
    }

    return graph;
  }
}
