import type { CellGrid } from "./types";
import { InputModal } from "./input-modal";
import { ListModal, type ListItem } from "./list-modal";
import { TextAreaModal } from "./textarea-modal";
import type { ModalAction } from "./modal";

export interface CreateIssueResult {
  teamId: string;
  title: string;
  description: string;
}

export interface CreateIssueModalConfig {
  teams: Array<{ id: string; name: string }>;
  preselectedTeamId: string | null;
}

type StepId = "team" | "title" | "description";

interface StackEntry {
  modal: ListModal | InputModal | TextAreaModal;
  stepId: StepId;
}

export class CreateIssueModal {
  private _open = false;
  private currentInner: ListModal | InputModal | TextAreaModal | null = null;
  private currentStep: StepId = "team";
  private stepStack: StackEntry[] = [];
  private config: CreateIssueModalConfig;

  private selectedTeamId = "";
  private selectedTeamName = "";
  private selectedTitle = "";

  constructor(config: CreateIssueModalConfig) {
    this.config = config;
  }

  open(): void {
    this._open = true;
    this.stepStack = [];
    this.selectedTeamId = "";
    this.selectedTeamName = "";
    this.selectedTitle = "";
    this.currentStep = "team";
    this.currentInner = this.createTeamPicker();
    this.currentInner.open();
  }

  close(): void {
    this._open = false;
    this.currentInner?.close();
    this.currentInner = null;
    this.stepStack = [];
    this.selectedTeamId = "";
    this.selectedTeamName = "";
    this.selectedTitle = "";
  }

  isOpen(): boolean {
    return this._open;
  }

  preferredWidth(termCols: number): number {
    return this.currentInner?.preferredWidth(termCols) ?? Math.min(Math.max(40, Math.round(termCols * 0.55)), 80);
  }

  getCursorPosition(): { row: number; col: number } | null {
    return this.currentInner?.getCursorPosition() ?? null;
  }

  getGrid(width: number): CellGrid {
    if (this.currentInner instanceof TextAreaModal) {
      const termRows = process.stdout.rows || 24;
      const maxHeight = Math.max(10, Math.round(termRows * 0.6));
      return this.currentInner.getGrid(width, maxHeight);
    }
    return this.currentInner!.getGrid(width);
  }

  handleInput(data: string): ModalAction {
    // Intercept Esc for back navigation
    if (data === "\x1b") {
      if (this.stepStack.length > 0) {
        const prev = this.stepStack.pop()!;
        this.currentInner = prev.modal;
        this.currentStep = prev.stepId;
        if (prev.stepId === "team") {
          this.selectedTeamId = "";
          this.selectedTeamName = "";
        } else if (prev.stepId === "title") {
          this.selectedTitle = "";
        }
        return { type: "consumed" };
      }
      this.close();
      return { type: "closed" };
    }

    const action = this.currentInner!.handleInput(data);

    if (action.type === "result") {
      return this.advanceStep(action.value);
    }

    if (action.type === "closed") {
      return { type: "consumed" };
    }

    return action;
  }

  private advanceStep(value: unknown): ModalAction {
    switch (this.currentStep) {
      case "team": {
        const item = value as ListItem;
        this.selectedTeamId = item.id;
        this.selectedTeamName = item.label;
        this.pushCurrentToStack();
        this.currentStep = "title";
        this.currentInner = new InputModal({
          header: "New Issue",
          subheader: this.breadcrumb(),
          placeholder: "Issue title",
        });
        this.currentInner.open();
        return { type: "consumed" };
      }

      case "title": {
        const title = value as string;
        this.selectedTitle = title;
        this.pushCurrentToStack();
        this.currentStep = "description";
        this.currentInner = new TextAreaModal({
          header: "New Issue",
          subheader: this.breadcrumb(),
        });
        this.currentInner.open();
        return { type: "consumed" };
      }

      case "description": {
        const description = value as string;
        const result: CreateIssueResult = {
          teamId: this.selectedTeamId,
          title: this.selectedTitle,
          description,
        };
        this.close();
        return { type: "result", value: result };
      }
    }

    return { type: "consumed" };
  }

  private pushCurrentToStack(): void {
    if (this.currentInner) {
      this.stepStack.push({
        modal: this.currentInner as ListModal | InputModal | TextAreaModal,
        stepId: this.currentStep,
      });
    }
  }

  private breadcrumb(): string {
    const parts: string[] = [];
    if (this.selectedTeamName) parts.push(this.selectedTeamName);
    if (this.selectedTitle) parts.push(this.selectedTitle);
    return parts.length > 0 ? parts.join(" > ") : "Select a team";
  }

  private createTeamPicker(): ListModal {
    const items: ListItem[] = this.config.teams.map((t) => ({
      id: t.id,
      label: t.name,
    }));

    if (this.config.preselectedTeamId) {
      const team = this.config.teams.find((t) => t.id === this.config.preselectedTeamId);
      if (team) {
        return new ListModal({
          header: "New Issue",
          subheader: "Select team",
          items,
          defaultQuery: team.name,
        });
      }
    }

    return new ListModal({
      header: "New Issue",
      subheader: "Select team",
      items,
    });
  }
}
