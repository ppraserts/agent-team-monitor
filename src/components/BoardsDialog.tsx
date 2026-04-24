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
  open: boolean;
  onClose: () => void;
}

const COLUMN_PALETTE = [
  "#5ed3ff", "#dab2ff", "#ff8ec7", "#9ef0a3",
  "#ffd28a", "#ff8aa3", "#a8a8b3",
] as const;

export function BoardsDialog({ open, onClose }: Props) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<number | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [editingCard, setEditingCard] = useState<BoardCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teamAgentNames = useStore(
    useShallow((s) => Object.values(s.agents).map((a) => a.snapshot.spec.name)),
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
    if (!open) return;
    refreshBoards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (activeBoardId != null) refreshBoard(activeBoardId);
  }, [activeBoardId]);

  // ---------- Board CRUD ----------
  const onCreateBoard = async () => {
    const name = prompt("Board name?");
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const b = await api.boardsCreate(name.trim(), null);
      await refreshBoards();
      setActiveBoardId(b.id);
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };

  const onRenameBoard = async (b: Board) => {
    const name = prompt("New board name?", b.name);
    if (!name?.trim() || name.trim() === b.name) return;
    try {
      await api.boardsUpdate(b.id, name.trim(), b.description ?? null);
      await refreshBoards();
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onDeleteBoard = async (b: Board) => {
    if (!confirm(`Delete board "${b.name}"? All columns and cards inside are removed too.`)) return;
    try {
      await api.boardsDelete(b.id);
      const next = boards.filter((x) => x.id !== b.id);
      setBoards(next);
      if (activeBoardId === b.id) setActiveBoardId(next[0]?.id ?? null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  // ---------- Column CRUD ----------
  const onAddColumn = async () => {
    if (!activeBoardId) return;
    const title = prompt("Column title?");
    if (!title?.trim()) return;
    const color = COLUMN_PALETTE[columns.length % COLUMN_PALETTE.length];
    try {
      await api.columnsCreate(activeBoardId, title.trim(), color);
      await refreshBoard(activeBoardId);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onRenameColumn = async (c: BoardColumn) => {
    const title = prompt("New column title?", c.title);
    if (!title?.trim() || title.trim() === c.title) return;
    try {
      await api.columnsUpdate(c.id, title.trim(), c.color);
      await refreshBoard(activeBoardId!);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onDeleteColumn = async (c: BoardColumn) => {
    if (!confirm(`Delete column "${c.title}" and all its cards?`)) return;
    try {
      await api.columnsDelete(c.id);
      await refreshBoard(activeBoardId!);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  // ---------- Card CRUD ----------
  const onAddCard = async (columnId: number) => {
    const title = prompt("Card title?");
    if (!title?.trim()) return;
    try {
      const card = await api.cardsCreate(columnId, {
        title: title.trim(),
        description: "",
        assignees: [],
        labels: [],
      });
      await refreshBoard(activeBoardId!);
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
    if (!confirm("Delete this card?")) return;
    try {
      await api.cardsDelete(id);
      setCards((cs) => cs.filter((c) => c.id !== id));
      if (editingCard?.id === id) setEditingCard(null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  const onSendCard = async (card: BoardCard) => {
    if (card.assignees.length === 0) {
      alert("Pick at least one assignee first.");
      return;
    }
    const text = `[BOARD TASK] ${card.title}\n\n${card.description ?? ""}`.trim();
    const liveAgents = useStore.getState().agents;
    let sent = 0;
    for (const name of card.assignees) {
      const target = Object.values(liveAgents).find(
        (a) => a.snapshot.spec.name === name,
      );
      if (!target) continue;
      try {
        await api.sendAgent(target.snapshot.id, text);
        sent++;
      } catch (e) {
        console.error("send card failed for", name, e);
      }
    }
    alert(
      sent === card.assignees.length
        ? `Sent to ${sent} assignee(s).`
        : `Sent to ${sent} of ${card.assignees.length}. The rest aren't currently spawned.`,
    );
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

  if (!open) return null;
  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? null;
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-950/80 backdrop-blur-sm">
      <div className="glass rounded-xl w-[1280px] max-w-[97vw] h-[92vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-base-800 flex items-center justify-between shrink-0">
          <div className="text-sm font-semibold tracking-wide flex items-center gap-2">
            <KanbanSquare size={14} className="text-(--color-accent-cyan)" />
            BOARDS
          </div>
          <button onClick={onClose} className="text-base-500 hover:text-base-200">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Boards list */}
          <aside className="w-56 shrink-0 border-r border-base-800 flex flex-col">
            <button
              onClick={onCreateBoard}
              disabled={busy}
              className="m-2 px-2 py-1.5 text-xs rounded-md bg-(--color-accent-cyan)/15 hover:bg-(--color-accent-cyan)/25 border border-(--color-accent-cyan)/30 text-(--color-accent-cyan) flex items-center justify-center gap-1.5"
            >
              <Plus size={12} /> New board
            </button>
            <div className="flex-1 overflow-y-auto px-1 pb-1 space-y-0.5">
              {boards.length === 0 && (
                <div className="text-xs text-base-600 italic p-3 text-center">
                  No boards yet. Click "+ New board".
                </div>
              )}
              {boards.map((b) => (
                <div
                  key={b.id}
                  onClick={() => setActiveBoardId(b.id)}
                  className={cn(
                    "group px-2 py-1.5 rounded cursor-pointer flex items-center gap-1.5 transition border",
                    activeBoardId === b.id
                      ? "bg-(--color-accent-cyan)/15 border-(--color-accent-cyan)/30"
                      : "hover:bg-base-800/60 border-transparent",
                  )}
                >
                  <KanbanSquare size={11} className="text-base-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{b.name}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRenameBoard(b); }}
                    className="opacity-0 group-hover:opacity-100 text-base-500 hover:text-base-200 transition"
                    title="Rename"
                  >
                    <Pencil size={10} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDeleteBoard(b); }}
                    className="opacity-0 group-hover:opacity-100 text-base-500 hover:text-(--color-accent-red) transition"
                    title="Delete"
                  >
                    <Trash2 size={10} />
                  </button>
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
                  <button
                    onClick={onAddColumn}
                    className="px-2 py-1 text-xs rounded-md bg-base-800/60 hover:bg-base-700/60 border border-base-700/50 flex items-center gap-1.5"
                  >
                    <Plus size={12} /> Column
                  </button>
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
                            onAddCard={() => onAddCard(col.id)}
                            onRenameColumn={() => onRenameColumn(col)}
                            onDeleteColumn={() => onDeleteColumn(col)}
                            onClickCard={(c) => setEditingCard(c)}
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
          <div className="mx-3 mb-2 p-2 rounded bg-(--color-accent-red)/10 border border-(--color-accent-red)/30 text-[11px] text-(--color-accent-red)">
            {error}
          </div>
        )}
      </div>

      {editingCard && (
        <CardEditor
          card={editingCard}
          teamAgentNames={teamAgentNames}
          onClose={() => setEditingCard(null)}
          onSave={onSaveCard}
          onDelete={() => onDeleteCard(editingCard.id)}
          onSend={() => onSendCard(editingCard)}
        />
      )}
    </div>
  );
}

// ----- Column -----

function ColumnView({
  column, cards, onAddCard, onRenameColumn, onDeleteColumn, onClickCard,
}: {
  column: BoardColumn;
  cards: BoardCard[];
  onAddCard: () => void;
  onRenameColumn: () => void;
  onDeleteColumn: () => void;
  onClickCard: (c: BoardCard) => void;
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
          <div className="text-xs font-semibold truncate" style={{ color: column.color ?? undefined }}>
            {column.title}
          </div>
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
                  onClick={() => { setMenuOpen(false); onRenameColumn(); }}
                  className="w-full text-left px-2 py-1 text-xs hover:bg-base-800/60 flex items-center gap-1.5"
                >
                  <Pencil size={11} /> Rename
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onDeleteColumn(); }}
                  className="w-full text-left px-2 py-1 text-xs hover:bg-(--color-accent-red)/10 text-(--color-accent-red) flex items-center gap-1.5"
                >
                  <Trash2 size={11} /> Delete
                </button>
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
            <CardView key={c.id} card={c} onClick={() => onClickCard(c)} />
          ))}
        </SortableContext>
        {cards.length === 0 && (
          <div className="text-[10px] text-base-600 italic text-center py-4">
            No cards
          </div>
        )}
      </div>

      <button
        onClick={onAddCard}
        className="m-1 px-2 py-1 text-[11px] rounded text-base-400 hover:bg-base-800/60 hover:text-base-200 flex items-center gap-1.5"
      >
        <Plus size={11} /> Add card
      </button>
    </div>
  );
}

// ----- Card -----

function CardView({ card, onClick }: { card: BoardCard; onClick: () => void }) {
  const sortable = useSortable({ id: `card-${card.id}` });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      {...sortable.attributes}
      {...sortable.listeners}
      onClick={onClick}
      className={cn(
        "rounded-md border border-base-700/60 bg-base-800/60 hover:bg-base-800 hover:border-(--color-accent-cyan)/40 px-2.5 py-2 cursor-pointer transition",
        sortable.isDragging && "opacity-40",
      )}
    >
      <div className="text-xs font-medium leading-snug">{card.title}</div>
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
  card, teamAgentNames, onClose, onSave, onDelete, onSend,
}: {
  card: BoardCard;
  teamAgentNames: string[];
  onClose: () => void;
  onSave: (c: BoardCard) => void;
  onDelete: () => void;
  onSend: () => void;
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

  const addLabel = () => {
    const l = prompt("Label name?");
    if (!l?.trim()) return;
    setDraft((d) => ({ ...d, labels: [...new Set([...d.labels, l.trim()])] }));
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
              <button
                onClick={addLabel}
                className="px-1.5 py-0.5 text-[11px] rounded border border-base-700/50 text-base-400 hover:bg-base-800/60"
              >
                + add label
              </button>
            </div>
          </div>

          <div className="text-[10px] text-base-600">
            Created {new Date(card.created_at).toLocaleString()} · Updated{" "}
            {new Date(card.updated_at).toLocaleString()}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-base-800 flex items-center gap-2">
          <button
            onClick={onDelete}
            className="px-2 py-1.5 text-xs rounded text-(--color-accent-red) hover:bg-(--color-accent-red)/10 border border-(--color-accent-red)/30 flex items-center gap-1.5"
          >
            <Trash2 size={12} /> Delete
          </button>
          <button
            onClick={onSend}
            disabled={draft.assignees.length === 0}
            className="px-2 py-1.5 text-xs rounded bg-(--color-accent-violet)/15 hover:bg-(--color-accent-violet)/25 border border-(--color-accent-violet)/40 text-(--color-accent-violet) disabled:opacity-40 flex items-center gap-1.5"
            title="Send the card title + description as a chat message to all assignees"
          >
            <Send size={12} /> Send to assignees
          </button>
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
