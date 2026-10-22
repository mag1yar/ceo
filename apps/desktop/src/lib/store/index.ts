import { invoke } from "@tauri-apps/api/core"
import type { Board, BoardChanges, Project } from "./types"

export type * from "./types"

export const store = {
  listProjects: () => invoke<Project[]>("project_list"),
  createProject: (name: string, path: string) =>
    invoke<Project>("project_create", { name, path }),
  updateProject: (id: string, name: string, path: string) =>
    invoke<Project>("project_update", { id, name, path }),
  touchProject: (id: string) => invoke<Project>("project_touch", { id }),
  deleteProject: (id: string) => invoke<void>("project_delete", { id }),
  reorderProjects: (ids: string[]) => invoke<void>("project_reorder", { ids }),
  loadBoard: (projectId: string) => invoke<Board>("board_load", { projectId }),
  saveBoard: (projectId: string, changes: Partial<BoardChanges>) =>
    invoke<void>("board_save", { projectId, changes }),
}
