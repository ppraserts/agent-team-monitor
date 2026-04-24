import { useEffect, useMemo, useState } from "react";
import {
  X, Plus, Trash2, Send, Pencil, KanbanSquare, Check,
  GripVertical, MoreHorizontal, Tag, Users,
} from "lucide-react";
import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { useStore } from "../store";
import { cn } from "../lib/cn";
import type { Board, BoardCard, BoardColumn } from "../types";

interface Props {
  /// Optional close handler — when provided, a small × button shows in the
  /// header. Useful when this is hosted inside a collapsible split panel.
  onClose?: () => void;
}

const COLUMN_PALETTE = [
  "#5ed3ff", "#dab2ff", "#ff8ec7", "#9ef0a3",
  "#ffd28a", "#ff8aa3", "#a8a8b3",
] as const;

export function BoardsPanel({ onClose }: Props) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<number | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [editingCard, setEditingCard] = useState<BoardCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline-edit state (replaces native prompt/confirm/alert)
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [renamingBoardId, setRenamingBoardId] = useState<number | null>(null);
  const [creatingColumn, setCreatingColumn] = useState(false);
  const [renamingColumnId, setRenamingColumnId] = useState<number | null>(null);
  const [creatingCardInColumn, setCreatingCardInColumn] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  };

  const teamAgentNames = useStore(
    useShallow((s) => Object.values(s.agents).map((a) => a.snapshot.spec.name)),
  );
  /// agent_id → { cardId, cardTitle, boardId } — populated by Send.
  const agentCardLink = useStore((s) => s.agentCardLink);
  /// name → snapshot lookup so cards can show whether their assignees are
  /// currently busy / idle / not spawned.
  const agentsByName = useStore(
    useShallow((s) =>
      Object.fromEntries(
        Object.values(s.agents).map((a) => [a.snapshot.spec.name, a.snapshot]),
      ),
    ),
  );

  const refreshBoards = async () => {
    try {
      const list = await api.boardsList();
      setBoards(list);
      if (list.length > 0 && activeBoardId == null) {
        setActiveBoardId(list[0].id);
      }
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const refreshBoard = async (id: number) => {
    try {
      const [cols, cs] = await Promise.all([
        api.columnsList(id),
        api.cardsList(id),
      ]);
      setColumns(cols);
      setCards(cs);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  useEffect(() => {
    refreshBoards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeBoardId != null) refreshBoard(activeBoardId);
  }, [activeBoardId]);

  // ---------- Board CRUD ----------
  const onCreateBoard = async (name: string) => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const b = await api.boardsCreate(name.trim(), null);
      await refreshBoards();
      setActiveBoardId(b.id);
      setCreatingBoard(false);
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };

  const onRenameBoard = async (b: Board, name: string) => {
    if (!name.trim() || name.trim() === b.name) {
      setRenamingBoardId(null);
      return;
    }
    try {
      await api.boardsUpdate(b.id, name.trim(), b.description ?? null);
      await refreshBoards();
      setRenamingBoardId(null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onDeleteBoard = async (b: Board) => {
    try {
      await api.boardsDelete(b.id);
      const next = boards.filter((x) => x.id !== b.id);
      setBoards(next);
      if (activeBoardId === b.id) setActiveBoardId(next[0]?.id ?? null);
      showToast(`Deleted board "${b.name}"`);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  // ---------- Column CRUD ----------
  const onAddColumn = async (title: string) => {
    if (!activeBoardId || !title.trim()) return;
    const color = COLUMN_PALETTE[columns.length % COLUMN_PALETTE.length];
    try {
      await api.columnsCreate(activeBoardId, title.trim(), color);
      await refreshBoard(activeBoardId);
      setCreatingColumn(false);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onRenameColumn = async (c: BoardColumn, title: string) => {
    if (!title.trim() || title.trim() === c.title) {
      setRenamingColumnId(null);
      return;
    }
    try {
      await api.columnsUpdate(c.id, title.trim(), c.color);
      await refreshBoard(activeBoardId!);
      setRenamingColumnId(null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onDeleteColumn = async (c: BoardColumn) => {
    try {
      await api.columnsDelete(c.id);
      await refreshBoard(activeBoardId!);
      showToast(`Deleted column "${c.title}"`);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  // ---------- Card CRUD ----------
  const onAddCard = async (columnId: number, title: string) => {
    if (!title.trim()) return;
    try {
      const card = await api.cardsCreate(columnId, {
        title: title.trim(),
        description: "",
        assignees: [],
        labels: [],
      });
      await refreshBoard(activeBoardId!);
      setCreatingCardInColumn(null);
      setEditingCard(card);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onSaveCard = async (c: BoardCard) => {
    try {
      const saved = await api.cardsUpdate(c.id, {
        title: c.title,
        description: c.description ?? "",
        assignees: c.assignees,
        labels: c.labels,
      });
      setEditingCard(null);
      // Optimistic local update
      setCards((cs) => cs.map((x) => (x.id === saved.id ? saved : x)));
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onDeleteCard = async (id: number) => {
    try {
      await api.cardsDelete(id);
      useStore.getState().unlinkCard(id);
      setCards((cs) => cs.filter((c) => c.id !== id));
      if (editingCard?.id === id) setEditingCard(null);
      showToast("Card deleted");
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onSendCard = async (card: BoardCard) => {
    if (card.assignees.length === 0) {
      showToast("Pick at least one assignee first.");
      return;
    }
    const text = `[BOARD TASK] ${card.title}\n\n${card.description ?? ""}`.trim();
    const liveAgents = useStore.getState().agents;
    const linkedAgentIds: string[] = [];
    let sent = 0;
    for (const name of card.assignees) {
      const target = Object.values(liveAgents).find(
        (a) => a.snapshot.spec.name === name,
      );
      if (!target) continue;
      try {
        await api.sendAgent(target.snapshot.id, text);
        linkedAgentIds.push(target.snapshot.id);
        sent++;
      } catch (e) {
        console.error("send card failed for", name, e);
      }
    }

    if (sent > 0) {
      // Auto-advance card to the next column (treat the column order as the
      // workflow). If we're already at the last column, leave it where it is.
      const currentIdx = columns.findIndex((c) => c.id === card.column_id);
      const nextCol =
        currentIdx >= 0 && currentIdx < columns.length - 1
          ? columns[currentIdx + 1]
          : null;
      if (nextCol) {
        try {
          await api.cardsMove(card.id, nextCol.id, 0);
          await refreshBoard(activeBoardId!);
        } catch (e) {
          console.error("auto-move on send failed:", e);
        }
      }

      // Link the agents → this card so we can show 'Working: <card>' on
      // their chat panel and 'Working' on the card.
      useStore.getState().linkAgentsToCard(
        linkedAgentIds,
        card.id,
        card.title,
        activeBoardId!,
      );
    }

    if (sent === card.assignees.length) {
      showToast(`Sent "${card.title}" to ${sent} agent${sent === 1 ? "" : "s"}.`);
    } else {
      showToast(
        `Sent to ${sent} of ${card.assignees.length}. The rest aren't currently spawned.`,
      );
    }
  };

  const onMarkDone = async (card: BoardCard) => {
    if (columns.length === 0) return;
    const lastCol = columns[columns.length - 1];
    if (card.column_id === lastCol.id) {
      // Already in the rightmost column — just unlink agents.
      useStore.getState().unlinkCard(card.id);
      return;
    }
    try {
      await api.cardsMove(card.id, lastCol.id, 0);
      useStore.getState().unlinkCard(card.id);
      setEditingCard(null);
      await refreshBoard(activeBoardId!);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  // ---------- Drag-drop ----------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragStart = (_e: DragStartEvent) => {
    // Reserved for future overlay rendering.
  };

  const onDragOver = (e: DragOverEvent) => {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    if (!activeId.startsWith("card-")) return;

    // Determine source + dest columns from current state.
    const activeCardId = Number(activeId.slice(5));
    const activeCard = cards.find((c) => c.id === activeCardId);
    if (!activeCard) return;

    let destColId: number | null = null;
    if (overId.startsWith("col-")) {
      destColId = Number(overId.slice(4));
    } else if (overId.startsWith("card-")) {
      const overCard = cards.find((c) => c.id === Number(overId.slice(5)));
      if (overCard) destColId = overCard.column_id;
    }
    if (destColId == null || destColId === activeCard.column_id) return;

    // Optimistically move into the new column at end (visual only — final
    // position settled in onDragEnd).
    setCards((cs) =>
      cs.map((c) =>
        c.id === activeCard.id ? { ...c, column_id: destColId! } : c,
      ),
    );
  };

  const onDragEnd = async (e: DragEndEvent) => {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;

    // ----- Column reorder -----
    if (activeId.startsWith("colhdr-") && overId.startsWith("colhdr-")) {
      const a = Number(activeId.slice(7));
      const b = Number(overId.slice(7));
      if (a === b) return;
      const idxA = columns.findIndex((c) => c.id === a);
      const idxB = columns.findIndex((c) => c.id === b);
      if (idxA < 0 || idxB < 0) return;
      const next = arrayMove(columns, idxA, idxB);
      setColumns(next);
      try {
        await api.columnsReorder(activeBoardId!, next.map((c) => c.id));
      } catch (e: any) { setError(String(e?.message ?? e)); }
      return;
    }

    // ----- Card move -----
    if (activeId.startsWith("card-")) {
      const cardId = Number(activeId.slice(5));
      const card = cards.find((c) => c.id === cardId);
      if (!card) return;

      let destColId: number;
      let destIndex: number;
      if (overId.startsWith("col-")) {
        destColId = Number(overId.slice(4));
        destIndex = cards.filter(
          (c) => c.column_id === destColId && c.id !== cardId,
        ).length;
      } else if (overId.startsWith("card-")) {
        const overCard = cards.find((c) => c.id === Number(overId.slice(5)));
        if (!overCard) return;
        destColId = overCard.column_id;
        const sameCol = cards
          .filter((c) => c.column_id === destColId && c.id !== cardId)
          .sort((a, b) => a.position - b.position);
        destIndex = sameCol.findIndex((c) => c.id === overCard.id);
        if (destIndex < 0) destIndex = sameCol.length;
      } else {
        return;
      }

      try {
        await api.cardsMove(cardId, destColId, destIndex);
        await refreshBoard(activeBoardId!);
      } catch (e: any) { setError(String(e?.message ?? e)); }
    }
  };

  const collisionDetection: CollisionDetection = (args) => {
    // Cards prefer rectIntersection (more responsive within column),
    // otherwise pointerWithin.
    const r = rectIntersection(args);
    if (r.length > 0) return r;
    return pointerWithin(args);
  };

  // IMPORTANT: this useMemo must be ABOVE any early `return` (Rules of Hooks).
  // When `!open` we still call the hook so React sees a stable hook order
  // across renders.
  const cardsByColumn = useMemo(() => {
    const m = new Map<number, BoardCard[]>();
    for (const c of cards) {
      const arr = m.get(c.column_id) ?? [];
      arr.push(c);
      m.set(c.column_id, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => a.position - b.position);
    }
    return m;
  }, [cards]);

  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? null;

  return (
    <>
    <div className="relative h-full w-full flex flex-col bg-base-950/40 border-t border-base-800">
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-base-800 flex items-center justify-between shrink-0 bg-base-900/40">
        <div className="text-[11px] font-semibold tracking-wide flex items-center gap-1.5 text-(--color-accent-cyan)">
          <KanbanSquare size={12} />
          BOARDS
        </div>
        {onClose && (
          <button onClick={onClose} className="text-base-500 hover:text-base-200" title="Hide board panel">
            <X size={14} />
          </button>
        )}
      </div>

        <div className="flex-1 flex min-h-0">
          {/* Boards list */}
          <aside className="w-56 shrink-0 border-r border-base-800 flex flex-col">
            {creatingBoard ? (
              <InlineCreator
                placeholder="Board name"
                onSubmit={onCreateBoard}
                onCancel={() => setCreatingBoard(false)}
                className="m-2"
              />
            ) : (
              <button
                onClick={() => setCreatingBoard(true)}
                disabled={busy}
                className="m-2 px-2 py-1.5 text-xs rounded-md bg-(--color-accent-cyan)/15 hover:bg-(--color-accent-cyan)/25 border border-(--color-accent-cyan)/30 text-(--color-accent-cyan) flex items-center justify-center gap-1.5"
              >
                <Plus size={12} /> New board
              </button>
            )}
            <div className="flex-1 overflow-y-auto px-1 pb-1 space-y-0.5">
              {boards.length === 0 && !creatingBoard && (
                <div className="text-xs text-base-600 italic p-3 text-center">
                  No boards yet. Click "+ New board".
                </div>
              )}
              {boards.map((b) => (
                <div
                  key={b.id}
                  onClick={() => renamingBoardId !== b.id && setActiveBoardId(b.id)}
                  className={cn(
                    "group px-2 py-1.5 rounded cursor-pointer flex items-center gap-1.5 transition border",
                    activeBoardId === b.id
                      ? "bg-(--color-accent-cyan)/15 border-(--color-accent-cyan)/30"
                      : "hover:bg-base-800/60 border-transparent",
                  )}
                >
                  <KanbanSquare size={11} className="text-base-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    {renamingBoardId === b.id ? (
                      <InlineEdit
                        initial={b.name}
                        onSubmit={(v) => onRenameBoard(b, v)}
                        onCancel={() => setRenamingBoardId(null)}
                      />
                    ) : (
                      <div
                        className="text-xs font-medium truncate"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setRenamingBoardId(b.id);
                        }}
                      >
                        {b.name}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setRenamingBoardId(b.id); }}
                    className="opacity-0 group-hover:opacity-100 text-base-500 hover:text-base-200 transition"
                    title="Rename (or double-click name)"
                  >
                    <Pencil size={10} />
                  </button>
                  <ConfirmIconButton
                    icon={<Trash2 size={10} />}
                    onConfirm={() => onDeleteBoard(b)}
                    title="Delete board"
                    className="opacity-0 group-hover:opacity-100"
                    danger
                  />
                </div>
              ))}
            </div>
          </aside>

          {/* Board view */}
          <main className="flex-1 min-w-0 flex flex-col">
            {!activeBoard ? (
              <div className="flex-1 flex items-center justify-center text-base-500 text-sm">
                Pick or create a board on the left.
              </div>
            ) : (
              <>
                <div className="px-4 py-3 border-b border-base-800 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold">{activeBoard.name}</div>
                    {activeBoard.description && (
                      <div className="text-[11px] text-base-500">
                        {activeBoard.description}
                      </div>
                    )}
                  </div>
                  {creatingColumn ? (
                    <InlineCreator
                      placeholder="Column title"
                      onSubmit={onAddColumn}
                      onCancel={() => setCreatingColumn(false)}
                    />
                  ) : (
                    <button
                      onClick={() => setCreatingColumn(true)}
                      className="px-2 py-1 text-xs rounded-md bg-base-800/60 hover:bg-base-700/60 border border-base-700/50 flex items-center gap-1.5"
                    >
                      <Plus size={12} /> Column
                    </button>
                  )}
                </div>

                <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-3">
                  <DndContext
                    sensors={sensors}
                    collisionDetection={collisionDetection}
                    onDragStart={onDragStart}
                    onDragOver={onDragOver}
                    onDragEnd={onDragEnd}
                  >
                    <SortableContext
                      items={columns.map((c) => `colhdr-${c.id}`)}
                      strategy={horizontalListSortingStrategy}
                    >
                      <div className="flex gap-3 h-full items-start">
                        {columns.map((col) => (
                          <ColumnView
                            key={col.id}
                            column={col}
                            cards={cardsByColumn.get(col.id) ?? []}
                            isCreatingCard={creatingCardInColumn === col.id}
                            isRenaming={renamingColumnId === col.id}
                            onStartAddCard={() => setCreatingCardInColumn(col.id)}
                            onSubmitAddCard={(title) => onAddCard(col.id, title)}
                            onCancelAddCard={() => setCreatingCardInColumn(null)}
                            onStartRename={() => setRenamingColumnId(col.id)}
                            onSubmitRename={(t) => onRenameColumn(col, t)}
                            onCancelRename={() => setRenamingColumnId(null)}
                            onDeleteColumn={() => onDeleteColumn(col)}
                            onClickCard={(c) => setEditingCard(c)}
                            agentCardLink={agentCardLink}
                            agentsByName={agentsByName}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </div>
              </>
            )}
          </main>
        </div>

      {error && (
        <div className="mx-3 mb-2 p-2 rounded bg-(--color-accent-red)/10 border border-(--color-accent-red)/30 text-[11px] text-(--color-accent-red) flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:text-base-200">
            <X size={11} />
          </button>
        </div>
      )}

      {toast && (
        <div className="absolute top-12 right-4 z-30 px-3 py-2 rounded-md bg-base-900/95 border border-(--color-accent-cyan)/40 text-xs text-base-200 shadow-xl animate-in fade-in slide-in-from-top-2 duration-200 flex items-center gap-2">
          <Check size={12} className="text-(--color-accent-cyan)" />
          {toast}
        </div>
      )}
    </div>

    {editingCard && (
      <CardEditor
        card={editingCard}
        teamAgentNames={teamAgentNames}
        isInLastColumn={
          columns.length > 0 &&
          editingCard.column_id === columns[columns.length - 1].id
        }
        onClose={() => setEditingCard(null)}
        onSave={onSaveCard}
        onDelete={() => onDeleteCard(editingCard.id)}
        onSend={() => onSendCard(editingCard)}
        onMarkDone={() => onMarkDone(editingCard)}
      />
    )}
    </>
  );
}

// ----- Column -----

function ColumnView({
  column, cards,
  isCreatingCard, isRenaming,
  onStartAddCard, onSubmitAddCard, onCancelAddCard,
  onStartRename, onSubmitRename, onCancelRename,
  onDeleteColumn, onClickCard,
  agentCardLink, agentsByName,
}: {
  column: BoardColumn;
  cards: BoardCard[];
  isCreatingCard: boolean;
  isRenaming: boolean;
  onStartAddCard: () => void;
  onSubmitAddCard: (title: string) => void;
  onCancelAddCard: () => void;
  onStartRename: () => void;
  onSubmitRename: (title: string) => void;
  onCancelRename: () => void;
  onDeleteColumn: () => void;
  onClickCard: (c: BoardCard) => void;
  agentCardLink: Record<string, { cardId: number; cardTitle: string; boardId: number }>;
  agentsByName: Record<string, import("../types").AgentSnapshot>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sortable = useSortable({ id: `colhdr-${column.id}` });
  const dropZone = useSortable({ id: `col-${column.id}` });

  const headerStyle = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  return (
    <div
      ref={sortable.setNodeRef}
      style={headerStyle}
      className={cn(
        "w-72 shrink-0 flex flex-col rounded-md bg-base-900/60 border border-base-800 max-h-full",
        sortable.isDragging && "opacity-50",
      )}
    >
      <div
        className="px-2 py-2 border-b border-base-800 flex items-center gap-1.5"
        style={{ borderTop: `2px solid ${column.color ?? "#5ed3ff"}` }}
      >
        <button
          {...sortable.attributes}
          {...sortable.listeners}
          className="text-base-500 hover:text-base-200 cursor-grab active:cursor-grabbing"
          title="Drag column to reorder"
        >
          <GripVertical size={12} />
        </button>
        <div className="flex-1 min-w-0">
          {isRenaming ? (
            <InlineEdit
              initial={column.title}
              onSubmit={onSubmitRename}
              onCancel={onCancelRename}
              color={column.color ?? undefined}
            />
          ) : (
            <div
              className="text-xs font-semibold truncate cursor-text"
              style={{ color: column.color ?? undefined }}
              onDoubleClick={onStartRename}
              title="Double-click to rename"
            >
              {column.title}
            </div>
          )}
        </div>
        <span className="text-[10px] text-base-500 font-mono">{cards.length}</span>
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="text-base-500 hover:text-base-200"
          >
            <MoreHorizontal size={12} />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-5 z-20 rounded-md border border-base-700 bg-base-950 shadow-lg min-w-32 py-1">
                <button
                  onClick={() => { setMenuOpen(false); onStartRename(); }}
                  className="w-full text-left px-2 py-1 text-xs hover:bg-base-800/60 flex items-center gap-1.5"
                >
                  <Pencil size={11} /> Rename
                </button>
                <ConfirmMenuItem
                  label="Delete column"
                  onConfirm={() => { setMenuOpen(false); onDeleteColumn(); }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div
        ref={dropZone.setNodeRef}
        className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-12"
      >
        <SortableContext
          items={cards.map((c) => `card-${c.id}`)}
          strategy={verticalListSortingStrategy}
        >
          {cards.map((c) => (
            <CardView
              key={c.id}
              card={c}
              onClick={() => onClickCard(c)}
              agentCardLink={agentCardLink}
              agentsByName={agentsByName}
            />
          ))}
        </SortableContext>
        {cards.length === 0 && (
          <div className="text-[10px] text-base-600 italic text-center py-4">
            No cards
          </div>
        )}
      </div>

      {isCreatingCard ? (
        <InlineCreator
          placeholder="Card title"
          onSubmit={onSubmitAddCard}
          onCancel={onCancelAddCard}
          className="m-1"
        />
      ) : (
        <button
          onClick={onStartAddCard}
          className="m-1 px-2 py-1 text-[11px] rounded text-base-400 hover:bg-base-800/60 hover:text-base-200 flex items-center gap-1.5"
        >
          <Plus size={11} /> Add card
        </button>
      )}
    </div>
  );
}

// ----- Card -----

function CardView({
  card, onClick, agentCardLink, agentsByName,
}: {
  card: BoardCard;
  onClick: () => void;
  agentCardLink: Record<string, { cardId: number; cardTitle: string; boardId: number }>;
  agentsByName: Record<string, import("../types").AgentSnapshot>;
}) {
  const sortable = useSortable({ id: `card-${card.id}` });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  // "Working" = at least one assignee is currently linked to THIS card AND
  // that agent's status is thinking/working (a turn is in flight).
  const linkedAgentIds = Object.entries(agentCardLink)
    .filter(([, link]) => link.cardId === card.id)
    .map(([aid]) => aid);
  const anyWorking = card.assignees.some((name) => {
    const snap = agentsByName[name];
    if (!snap) return false;
    if (!linkedAgentIds.includes(snap.id)) return false;
    return snap.status === "thinking" || snap.status === "working";
  });
  const anyLinked = linkedAgentIds.length > 0;

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      {...sortable.attributes}
      {...sortable.listeners}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-2 cursor-pointer transition",
        anyWorking
          ? "border-(--color-accent-cyan)/60 bg-(--color-accent-cyan)/5 glow-cyan"
          : anyLinked
          ? "border-(--color-accent-violet)/40 bg-base-800/60"
          : "border-base-700/60 bg-base-800/60 hover:bg-base-800 hover:border-(--color-accent-cyan)/40",
        sortable.isDragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-1.5">
        {anyWorking && (
          <span className="w-1.5 h-1.5 rounded-full bg-(--color-accent-cyan) mt-1.5 pulse-ring text-(--color-accent-cyan) shrink-0" />
        )}
        <div className="text-xs font-medium leading-snug flex-1 min-w-0">
          {card.title}
        </div>
      </div>
      {card.description && card.description.trim() && (
        <div className="text-[10px] text-base-500 mt-1 line-clamp-2 whitespace-pre-wrap">
          {card.description}
        </div>
      )}
      {(card.assignees.length > 0 || card.labels.length > 0) && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {card.labels.map((l) => (
            <span
              key={l}
              className="text-[9px] px-1.5 py-0.5 rounded bg-(--color-accent-amber)/15 text-(--color-accent-amber) border border-(--color-accent-amber)/30"
            >
              {l}
            </span>
          ))}
          {card.assignees.map((a) => (
            <span
              key={a}
              className="text-[9px] px-1.5 py-0.5 rounded bg-(--color-accent-violet)/15 text-(--color-accent-violet) border border-(--color-accent-violet)/30"
            >
              @{a}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ----- Card editor (modal) -----

function CardEditor({
  card, teamAgentNames, isInLastColumn, onClose, onSave, onDelete, onSend, onMarkDone,
}: {
  card: BoardCard;
  teamAgentNames: string[];
  isInLastColumn: boolean;
  onClose: () => void;
  onSave: (c: BoardCard) => void;
  onDelete: () => void;
  onSend: () => void;
  onMarkDone: () => void;
}) {
  const [draft, setDraft] = useState<BoardCard>(card);
  useEffect(() => { setDraft(card); }, [card.id]);

  const toggleAssignee = (name: string) => {
    setDraft((d) => ({
      ...d,
      assignees: d.assignees.includes(name)
        ? d.assignees.filter((x) => x !== name)
        : [...d.assignees, name],
    }));
  };

  const [addingLabel, setAddingLabel] = useState(false);
  const addLabel = (name: string) => {
    if (!name.trim()) return;
    setDraft((d) => ({ ...d, labels: [...new Set([...d.labels, name.trim()])] }));
    setAddingLabel(false);
  };
  const removeLabel = (l: string) => {
    setDraft((d) => ({ ...d, labels: d.labels.filter((x) => x !== l) }));
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-base-950/80 backdrop-blur-sm">
      <div className="glass rounded-xl w-[600px] max-w-[92vw] max-h-[88vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-base-800 flex items-center justify-between">
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className="flex-1 bg-transparent text-sm font-semibold outline-none"
            placeholder="Card title"
          />
          <button onClick={onClose} className="text-base-500 hover:text-base-200 ml-2">
            <X size={16} />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3">
          <div>
            <div className="text-[10px] tracking-wider text-base-500 mb-1 uppercase">
              Description
            </div>
            <textarea
              value={draft.description ?? ""}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={6}
              placeholder="What needs doing? Markdown OK."
              className="w-full bg-base-950 border border-base-700 rounded-md p-2 text-sm font-mono outline-none focus:border-(--color-accent-cyan)/50"
            />
          </div>

          <div>
            <div className="text-[10px] tracking-wider text-base-500 mb-1 uppercase flex items-center gap-1">
              <Users size={10} /> Assignees (live agents only)
            </div>
            {teamAgentNames.length === 0 ? (
              <div className="text-[11px] text-base-500 italic">
                No agents currently spawned. Spawn an agent first to assign it.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {teamAgentNames.map((name) => {
                  const on = draft.assignees.includes(name);
                  return (
                    <button
                      key={name}
                      onClick={() => toggleAssignee(name)}
                      className={cn(
                        "px-2 py-1 text-[11px] rounded-md border transition flex items-center gap-1",
                        on
                          ? "bg-(--color-accent-violet)/20 border-(--color-accent-violet)/40 text-(--color-accent-violet)"
                          : "bg-base-800/50 border-base-700/50 text-base-300 hover:bg-base-700/60",
                      )}
                    >
                      {on && <Check size={10} />}
                      @{name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="text-[10px] tracking-wider text-base-500 mb-1 uppercase flex items-center gap-1">
              <Tag size={10} /> Labels
            </div>
            <div className="flex flex-wrap gap-1.5">
              {draft.labels.map((l) => (
                <span
                  key={l}
                  className="px-1.5 py-0.5 text-[11px] rounded bg-(--color-accent-amber)/15 text-(--color-accent-amber) border border-(--color-accent-amber)/30 flex items-center gap-1"
                >
                  {l}
                  <button onClick={() => removeLabel(l)} className="hover:text-(--color-accent-red)">
                    <X size={9} />
                  </button>
                </span>
              ))}
              {addingLabel ? (
                <InlineCreator
                  placeholder="Label"
                  onSubmit={addLabel}
                  onCancel={() => setAddingLabel(false)}
                  small
                />
              ) : (
                <button
                  onClick={() => setAddingLabel(true)}
                  className="px-1.5 py-0.5 text-[11px] rounded border border-base-700/50 text-base-400 hover:bg-base-800/60"
                >
                  + add label
                </button>
              )}
            </div>
          </div>

          <div className="text-[10px] text-base-600">
            Created {new Date(card.created_at).toLocaleString()} · Updated{" "}
            {new Date(card.updated_at).toLocaleString()}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-base-800 flex items-center gap-2">
          <ConfirmTextButton
            label="Delete"
            confirmLabel="Click again to confirm"
            icon={<Trash2 size={12} />}
            onConfirm={onDelete}
          />
          <button
            onClick={onSend}
            disabled={draft.assignees.length === 0}
            className="px-2 py-1.5 text-xs rounded bg-(--color-accent-violet)/15 hover:bg-(--color-accent-violet)/25 border border-(--color-accent-violet)/40 text-(--color-accent-violet) disabled:opacity-40 flex items-center gap-1.5"
            title="Send the card title + description as a chat message to all assignees and auto-advance the card one column to the right"
          >
            <Send size={12} /> Send &amp; advance
          </button>
          {!isInLastColumn && (
            <button
              onClick={onMarkDone}
              className="px-2 py-1.5 text-xs rounded bg-(--color-accent-green)/15 hover:bg-(--color-accent-green)/25 border border-(--color-accent-green)/40 text-(--color-accent-green) flex items-center gap-1.5"
              title="Move this card to the rightmost column and unlink any working agents"
            >
              <Check size={12} /> Mark done
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded text-base-400 hover:bg-base-800/60"
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(draft)}
              className="px-3 py-1.5 text-xs rounded bg-(--color-accent-cyan)/20 hover:bg-(--color-accent-cyan)/30 border border-(--color-accent-cyan)/40 text-(--color-accent-cyan)"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== Inline UI helpers =====

/// Compact text input that submits on Enter, cancels on Esc, and saves on
/// blur. Used to replace native prompt() for inline title editing.
function InlineEdit({
  initial, onSubmit, onCancel, color,
}: {
  initial: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  color?: string;
}) {
  const [val, setVal] = useState(initial);
  return (
    <input
      autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onSubmit(val);
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => onSubmit(val)}
      className="w-full bg-base-950 border border-(--color-accent-cyan)/50 rounded px-1.5 py-0.5 text-xs font-medium outline-none"
      style={color ? { color } : undefined}
    />
  );
}

/// Inline "create new <thing>" form: text input + Save / Cancel.
function InlineCreator({
  placeholder, onSubmit, onCancel, className, small,
}: {
  placeholder: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  className?: string;
  small?: boolean;
}) {
  const [val, setVal] = useState("");
  const submit = () => {
    if (val.trim()) onSubmit(val.trim());
  };
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md border border-(--color-accent-cyan)/40 bg-base-950 p-1",
        className,
      )}
    >
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        className={cn(
          "flex-1 bg-transparent outline-none px-1.5",
          small ? "text-[11px]" : "text-xs",
        )}
      />
      <button
        onClick={submit}
        disabled={!val.trim()}
        className="px-1.5 py-0.5 text-[10px] rounded bg-(--color-accent-cyan)/20 hover:bg-(--color-accent-cyan)/30 text-(--color-accent-cyan) disabled:opacity-30"
      >
        Save
      </button>
      <button
        onClick={onCancel}
        className="px-1.5 py-0.5 text-[10px] rounded text-base-500 hover:bg-base-800/60"
      >
        ✕
      </button>
    </div>
  );
}

/// Trash-icon-style button that arms on first click, fires on second.
/// Auto-disarms after 2.5s of inactivity.
function ConfirmIconButton({
  icon, onConfirm, title, className, danger,
}: {
  icon: React.ReactNode;
  onConfirm: () => void;
  title: string;
  className?: string;
  danger?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
      title={armed ? "Click again to confirm" : title}
      className={cn(
        "transition px-1 rounded",
        armed
          ? "text-(--color-accent-red) bg-(--color-accent-red)/15 ring-1 ring-(--color-accent-red)/40 opacity-100"
          : danger
          ? "text-base-500 hover:text-(--color-accent-red)"
          : "text-base-500 hover:text-base-200",
        className,
      )}
    >
      {icon}
    </button>
  );
}

/// Same arm-then-confirm pattern but for full-width text buttons (used in
/// menus and the card-editor footer).
function ConfirmTextButton({
  label, confirmLabel, icon, onConfirm,
}: {
  label: string;
  confirmLabel: string;
  icon?: React.ReactNode;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      onClick={() => {
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
      className={cn(
        "px-2 py-1.5 text-xs rounded border flex items-center gap-1.5 transition",
        armed
          ? "bg-(--color-accent-red)/20 border-(--color-accent-red)/60 text-(--color-accent-red)"
          : "text-(--color-accent-red) hover:bg-(--color-accent-red)/10 border-(--color-accent-red)/30",
      )}
    >
      {icon} {armed ? confirmLabel : label}
    </button>
  );
}

/// Menu item variant of the same pattern, used inside the column ⋯ menu.
function ConfirmMenuItem({
  label, onConfirm,
}: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      onClick={() => {
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
      className={cn(
        "w-full text-left px-2 py-1 text-xs flex items-center gap-1.5 transition",
        armed
          ? "bg-(--color-accent-red)/20 text-(--color-accent-red)"
          : "hover:bg-(--color-accent-red)/10 text-(--color-accent-red)",
      )}
    >
      <Trash2 size={11} /> {armed ? "Confirm delete" : label}
    </button>
  );
}
