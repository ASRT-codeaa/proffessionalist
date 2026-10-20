import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Inbox,
  ListChecks,
  Plus,
  X,
} from "lucide-react";
import {
  Button,
  Card,
  ErrorState,
  EmptyState,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  Tabs,
  Textarea,
} from "@/components/ui";
import { TaskCard } from "@/components/cards";
import { useToast } from "@/context/ToastContext";
import { errorMessage, useAsync } from "@/hooks/useAsync";
import { networkApi, tasksApi } from "@/services/api";
import type { ApiError } from "@/services/http";
import type { Person, Task } from "@/services/types";
import { cn, fullName } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*  Views + date helpers                                                       */
/* -------------------------------------------------------------------------- */

type TaskView = "today" | "upcoming" | "overdue" | "completed" | "all";

const VIEWS: { id: TaskView; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "overdue", label: "Overdue" },
  { id: "completed", label: "Completed" },
  { id: "all", label: "All" },
];

const EMPTY_COPY: Record<TaskView, { title: string; description: string }> = {
  today: { title: "Nothing due today", description: "Your board is clear for today. Pull something forward or plan what matters next." },
  upcoming: { title: "No upcoming tasks", description: "Schedule the next step of a project and it will appear here." },
  overdue: { title: "Nothing overdue", description: "You're on top of everything. Overdue work would show up here." },
  completed: { title: "No completed tasks yet", description: "Tick a task off and it lands here, grouped by the day you finished it." },
  all: { title: "Your task list is empty", description: "Capture the follow-ups, deliverables and admin you don't want to lose." },
};

const DAY_MS = 86_400_000;

const startOfDay = (d: Date = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const keyToDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** Monday-based start of the week containing `date`. */
function weekStart(date: Date): Date {
  const dow = (date.getDay() + 6) % 7;
  return addDays(startOfDay(date), -dow);
}

/** Mirror of the server's view predicates so counts always match the list. */
function matchesView(task: Task, view: TaskView): boolean {
  const due = task.dueDate ? new Date(task.dueDate).getTime() : null;
  const sod = startOfDay().getTime();
  const eod = sod + DAY_MS;
  switch (view) {
    case "today":
      return task.status !== "done" && due !== null && due < eod;
    case "upcoming":
      return task.status !== "done" && due !== null && due >= eod;
    case "overdue":
      return task.status !== "done" && due !== null && due < sod;
    case "completed":
      return task.status === "done";
    case "all":
      return true;
  }
}

function byDue(a: Task, b: Task): number {
  return new Date(a.dueDate ?? 8e15).getTime() - new Date(b.dueDate ?? 8e15).getTime();
}

function dayHeading(key: string): string {
  const d = keyToDate(key);
  const diffDays = Math.round((startOfDay().getTime() - startOfDay(d).getTime()) / DAY_MS);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays === -1) return "Tomorrow";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/* ISO -> value of an <input type="datetime-local"> (local time, no seconds) */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CATEGORY_PRESETS = ["General", "Client work", "Design", "Engineering", "Finance", "Sales", "Marketing", "Admin", "Learning", "Errands"];

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function TasksPage() {
  const toast = useToast();
  const [view, setView] = useState<TaskView>("today");
  const [reload, setReload] = useState(0);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [calendarMode, setCalendarMode] = useState<"week" | "month">("week");
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [form, setForm] = useState<{ mode: "create" } | { mode: "edit"; task: Task } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);

  const all = useAsync(() => tasksApi.list({ view: "all" }), [reload]);
  const list = useAsync(() => tasksApi.list({ view }), [view, reload]);
  const connections = useAsync(() => networkApi.connections({ pageSize: 50 }), []);

  const allTasks = all.data ?? [];
  const people: Person[] = connections.data?.items ?? [];

  const counts = useMemo(() => {
    const out = {} as Record<TaskView, number>;
    for (const v of VIEWS) out[v.id] = allTasks.filter((t) => matchesView(t, v.id)).length;
    return out;
  }, [all.data]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Real due-date density for the calendar strip — derived from task data only. */
  const dayMap = useMemo(() => {
    const map = new Map<string, { total: number; open: number }>();
    for (const t of allTasks) {
      if (!t.dueDate) continue;
      const d = new Date(t.dueDate);
      if (Number.isNaN(d.getTime())) continue;
      const key = dayKey(d);
      const entry = map.get(key) ?? { total: 0, open: 0 };
      entry.total += 1;
      if (t.status !== "done") entry.open += 1;
      map.set(key, entry);
    }
    return map;
  }, [all.data]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Category choices = presets plus whatever the user already uses on their board. */
  const categoryOptions = useMemo(() => {
    const set = new Set(CATEGORY_PRESETS);
    for (const t of allTasks) if (t.category) set.add(t.category);
    if (form?.mode === "edit" && form.task.category) set.add(form.task.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [all.data, form]); // eslint-disable-line react-hooks/exhaustive-deps

  const tasks = list.data ?? [];  const shown = selectedDay ? tasks.filter((t) => t.dueDate && dayKey(new Date(t.dueDate)) === selectedDay) : tasks;
  const groups = useMemo(() => {
    if (view !== "completed") return null;
    const map = new Map<string, Task[]>();
    for (const t of shown) {
      const raw = t.completedAt ?? t.dueDate ?? t.createdAt;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) continue;
      const key = dayKey(d);
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [shown, view]);

  const loading = list.loading && !list.data;
  const showError = !!list.error && !list.loading;

  const refresh = () => setReload((n) => n + 1);

  /* ------------------------------ optimistic io ---------------------------- */

  const toggleTask = (task: Task) => {
    const nextStatus: Task["status"] = task.status === "done" ? "todo" : "done";
    const optimistic: Task = { ...task, status: nextStatus, completedAt: nextStatus === "done" ? new Date().toISOString() : null };

    all.setData((prev) => replace(prev, task.id, optimistic));
    list.setData((prev) => replace(prev, task.id, optimistic));

    tasksApi
      .toggle(task.id)
      .then((res) => {
        const settled: Task = { ...task, status: res.status, completedAt: res.completedAt };
        all.setData((prev) => replace(prev, task.id, settled));
        if (matchesView(settled, view)) list.setData((prev) => replace(prev, task.id, settled));
        else list.setData((prev) => (prev ?? []).filter((t) => t.id !== task.id));
        toast.success(res.status === "done" ? "Task completed" : "Task reopened");
      })
      .catch((e: unknown) => {
        all.setData((prev) => replace(prev, task.id, task));
        list.setData((prev) => replace(prev, task.id, task));
        toast.error(errorMessage(e));
      });
  };

  const submitTask = async (values: TaskFormValues) => {
    const payload: TaskPayload = {
      title: values.title.trim(),
      description: values.description.trim(),
      dueDate: values.dueDate ? new Date(values.dueDate).toISOString() : null,
      priority: values.priority,
      category: values.category,
      status: values.status,
      assigneeId: values.assigneeId ? Number(values.assigneeId) : null,
    };

    try {
      if (form?.mode === "edit") {
        const updated = await tasksApi.update(form.task.id, payload);
        all.setData((prev) => (prev ?? []).map((t) => (t.id === updated.id ? updated : t)).sort(byDue));
        list.setData((prev) => (matchesView(updated, view) ? insertSorted(prev, updated.id, updated) : (prev ?? []).filter((t) => t.id !== updated.id)));
        toast.success("Task updated");
      } else {
        const created = await tasksApi.create(payload);
        all.setData((prev) => insertSorted(prev, created.id, created));
        if (matchesView(created, view)) list.setData((prev) => insertSorted(prev, created.id, created));
        toast.success("Task created");
      }
      setForm(null);
    } catch (e) {
      const err = e as ApiError;
      if (err.fieldErrors && Object.keys(err.fieldErrors).length) {
        toast.error(err.message || "Please check the highlighted fields");
        return { ok: false, fieldErrors: err.fieldErrors } as const;
      }
      toast.error(errorMessage(e));
      return { ok: false, fieldErrors: { title: errorMessage(e) } } as const;
    }
    return { ok: true } as const;
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    all.setData((prev) => (prev ?? []).filter((t) => t.id !== target.id));
    list.setData((prev) => (prev ?? []).filter((t) => t.id !== target.id));
    try {
      await tasksApi.delete(target.id);
      toast.success("Task deleted");
    } catch (e) {
      all.setData((prev) => insertSorted(prev, target.id, target));
      list.setData((prev) => insertSorted(prev, target.id, target));
      toast.error(errorMessage(e));
      refresh();
    }
  };

  /* --------------------------------- render -------------------------------- */

  const todayKey = dayKey(new Date());
  const overdueCount = counts.overdue ?? 0;

  return (
    <div className="w-full space-y-4 px-3 pb-2 sm:px-0 anim-fade-up">
      <header className="sticky top-14 z-30 -mx-3 space-y-3 bg-canvas/95 px-3 pb-1 pt-1 backdrop-blur md:top-16 md:mx-0 md:px-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-extrabold">
              <ListChecks size={19} className="text-accent" aria-hidden />
              Tasks
            </h1>
            <p className="mt-0.5 text-[13px] text-ink-soft" aria-live="polite">
              {all.loading && !all.data
                ? "Loading your board…"
                : `${counts.today} open today · ${counts.upcoming} upcoming · ${counts.completed} done`}
              {overdueCount > 0 && <span className="ml-1.5 font-semibold text-danger">· {overdueCount} overdue</span>}
            </p>
          </div>
          <Button size="sm" onClick={() => setForm({ mode: "create" })}>
            <Plus size={15} /> New task
          </Button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <Tabs
            items={VIEWS.map((v) => ({ id: v.id, label: v.label, count: all.data ? counts[v.id] : undefined }))}
            value={view}
            onChange={(id) => {
              setView(id as TaskView);
              setSelectedDay(null);
            }}
            className="border-b-0 px-1"
          />
        </div>
      </header>

      <CalendarPanel
        mode={calendarMode}
        onModeChange={setCalendarMode}
        weekOffset={weekOffset}
        monthOffset={monthOffset}
        onWeekChange={setWeekOffset}
        onMonthChange={setMonthOffset}
        dayMap={dayMap}
        selectedDay={selectedDay}
        onSelectDay={(key) => setSelectedDay((prev) => (prev === key ? null : key))}
        loading={all.loading && !all.data}
        todayKey={todayKey}
      />

      {!all.loading && all.error && (
        <p className="flex flex-wrap items-center justify-center gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[13px] font-semibold text-warn">
          <AlertTriangle size={15} aria-hidden /> Couldn’t load calendar density or view counts.
          <button onClick={all.refetch} className="underline">
            Retry
          </button>
        </p>
      )}

      {selectedDay && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-soft">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 font-semibold text-accent">
            <CalendarDays size={13} aria-hidden />
            {dayHeading(selectedDay)}
          </span>
          <span>{shown.length === 1 ? "1 task" : `${shown.length} tasks`} on this day</span>
          <Button variant="ghost" size="sm" onClick={() => setSelectedDay(null)}>
            <X size={14} /> Clear day
          </Button>
        </div>
      )}

      {loading && <TasksSkeleton />}

      {showError && (
        <Card>
          <ErrorState message={errorMessage(list.error)} onRetry={list.refetch} />
        </Card>
      )}

      {!loading && !showError && shown.length === 0 && (
        <Card>
          <EmptyState
            icon={selectedDay ? <CalendarDays /> : view === "overdue" ? <AlertTriangle /> : view === "completed" ? <CheckCircle2 /> : <Inbox />}
            title={selectedDay ? "Nothing scheduled for this day" : EMPTY_COPY[view].title}
            description={selectedDay ? "Pick another day on the calendar or clear the filter." : EMPTY_COPY[view].description}
            action={
              selectedDay ? (
                <Button variant="outline" onClick={() => setSelectedDay(null)}>
                  Show all {VIEWS.find((v) => v.id === view)?.label.toLowerCase()} tasks
                </Button>
              ) : (
                <Button onClick={() => setForm({ mode: "create" })}>
                  <Plus size={15} /> Create a task
                </Button>
              )
            }
          />
        </Card>
      )}

      {!loading && !showError && shown.length > 0 && (
        <section className="space-y-4" aria-label={`${view} tasks`}>
          {groups
            ? groups.map(([key, items]) => (
                <div key={key} className="space-y-2">
                  <h2 className="flex items-center gap-1.5 px-1 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
                    <CheckCircle2 size={12} className="text-success" aria-hidden />
                    {dayHeading(key)}
                    <span className="font-semibold normal-case tracking-normal">· {items.length} done</span>
                  </h2>
                  <div className="space-y-2.5">
                    {items.map((t) => (
                      <TaskCard key={t.id} task={t} onToggle={toggleTask} onEdit={(task) => setForm({ mode: "edit", task })} onDelete={setDeleteTarget} />
                    ))}
                  </div>
                </div>
              ))
            : (
                <ul className="space-y-2.5">
                  {shown.map((t) => (
                    <li key={t.id}>
                      <TaskCard task={t} onToggle={toggleTask} onEdit={(task) => setForm({ mode: "edit", task })} onDelete={setDeleteTarget} />
                    </li>
                  ))}
                </ul>
              )}
          <p className="pb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            {counts.all} task{counts.all === 1 ? "" : "s"} on your board
          </p>
        </section>
      )}

      {form && (
        <TaskFormModal
          key={form.mode === "edit" ? `edit-${form.task.id}` : "create"}
          task={form.mode === "edit" ? form.task : null}
          people={people}
          peopleLoading={connections.loading && !connections.data}
          connectionsFailed={!!connections.error && !connections.data}
          categories={categoryOptions}
          onClose={() => setForm(null)}
          onSubmit={submitTask}
        />
      )}

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete task"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>
              Delete task
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          <span className="font-semibold text-ink">{deleteTarget?.title}</span> will be removed from your board. This can't be undone.
        </p>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Local list utilities                                                       */
/* -------------------------------------------------------------------------- */

function replace(prev: Task[] | null, id: number, next: Task): Task[] {
  return (prev ?? []).map((t) => (t.id === id ? next : t));
}

function insertSorted(prev: Task[] | null, id: number, next: Task): Task[] {
  return (prev ?? []).filter((t) => t.id !== id).concat(next).sort(byDue);
}

/* -------------------------------------------------------------------------- */
/*  Calendar                                                                   */
/* -------------------------------------------------------------------------- */

function CalendarPanel({
  mode,
  onModeChange,
  weekOffset,
  monthOffset,
  onWeekChange,
  onMonthChange,
  dayMap,
  selectedDay,
  onSelectDay,
  loading,
  todayKey,
}: {
  mode: "week" | "month";
  onModeChange: (m: "week" | "month") => void;
  weekOffset: number;
  monthOffset: number;
  onWeekChange: (n: number) => void;
  onMonthChange: (n: number) => void;
  dayMap: Map<string, { total: number; open: number }>;
  selectedDay: string | null;
  onSelectDay: (key: string) => void;
  loading: boolean;
  todayKey: string;
}) {
  const weekDays = useMemo(() => {
    const start = addDays(weekStart(new Date()), weekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [weekOffset]);

  const monthGrid = useMemo(() => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const monthIndex = first.getMonth();
    const lead = (first.getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => {
      const date = addDays(first, i - lead);
      return { date, inMonth: date.getMonth() === monthIndex };
    });
  }, [monthOffset]);

  const monthLabel = useMemo(() => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    return first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }, [monthOffset]);

  const weekLabel = `${weekDays[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekDays[6].toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;

  return (
    <Card className="p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={mode}
          onChange={(v) => onModeChange(v as "week" | "month")}
          options={[
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
        <p className="text-[13px] font-semibold text-ink-soft">{mode === "week" ? weekLabel : monthLabel}</p>
      </div>

      {loading ? (
        <div className="mt-3 grid grid-cols-7 gap-1.5">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : mode === "week" ? (
        <>
          <div className="mt-3 grid grid-cols-7 gap-1.5">
            {weekDays.map((d) => (
              <DayCell key={d.toISOString()} date={d} compact day={dayMap.get(dayKey(d))} today={dayKey(d) === todayKey} selected={selectedDay === dayKey(d)} onClick={() => onSelectDay(dayKey(d))} />
            ))}
          </div>
          <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2.5">
            <Button variant="ghost" size="sm" onClick={() => onWeekChange(weekOffset - 1)}>
              <ChevronLeft size={15} /> Prev week
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onWeekChange(0)}>
              This week
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onWeekChange(weekOffset + 1)}>
              Next week <ChevronRight size={15} />
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase tracking-wider text-ink-faint" aria-hidden>
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <span key={d} className="py-1">
                {d}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {monthGrid.map(({ date: d, inMonth }) => (
              <DayCell
                key={d.toISOString()}
                date={d}
                dimmed={!inMonth}
                day={dayMap.get(dayKey(d))}
                today={dayKey(d) === todayKey}
                selected={selectedDay === dayKey(d)}
                onClick={() => onSelectDay(dayKey(d))}
              />
            ))}
          </div>
          <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2.5">
            <Button variant="ghost" size="sm" onClick={() => onMonthChange(monthOffset - 1)}>
              <ChevronLeft size={15} /> Prev
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onMonthChange(0)}>
              This month
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onMonthChange(monthOffset + 1)}>
              Next <ChevronRight size={15} />
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function DayCell({
  date,
  day,
  today,
  selected,
  dimmed,
  compact,
  onClick,
}: {
  date: Date;
  day?: { total: number; open: number };
  today: boolean;
  selected: boolean;
  dimmed?: boolean;
  compact?: boolean;
  onClick: () => void;
}) {
  const total = day?.total ?? 0;
  const open = day?.open ?? 0;
  const dots = Math.min(3, total);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}${
        total ? ` — ${total} task${total === 1 ? "" : "s"}, ${open} open` : " — no tasks"
      }`}
      className={cn(
        "flex min-h-[52px] w-full flex-col items-center justify-center gap-1 rounded-xl border px-1 py-1.5 text-center transition-colors",
        compact ? "min-h-[64px]" : "min-h-[44px]",
        selected ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-2",
        dimmed && !selected && "opacity-45",
        today && !selected && "border-line-strong"
      )}
    >
      <span className="text-[10px] font-bold uppercase tracking-wide text-ink-faint">{date.toLocaleDateString(undefined, { weekday: "narrow" })}</span>
      <span className={cn("text-sm font-extrabold tabular-nums", today && !selected && "text-accent")}>{date.getDate()}</span>
      <span className="flex h-2 items-center gap-0.5" aria-hidden>
        {dots === 0 ? (
          <span className="h-0.5 w-2 rounded-full bg-line" />
        ) : (
          Array.from({ length: dots }).map((_, i) => <span key={i} className={cn("h-1.5 w-1.5 rounded-full", i < open ? "bg-accent" : "bg-line-strong")} />)
        )}
      </span>
      {total > 0 && <span className="text-[10px] font-bold tabular-nums text-ink-soft">{total}</span>}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Create / edit form                                                         */
/* -------------------------------------------------------------------------- */

type TaskPayload = Omit<Partial<Task>, "assignee" | "title"> & { title: string; assigneeId?: number | null };

interface TaskFormValues {
  title: string;
  description: string;
  dueDate: string;
  priority: Task["priority"];
  category: string;
  status: Task["status"];
  assigneeId: string;
}

function TaskFormModal({
  task,
  people,
  peopleLoading,
  connectionsFailed,
  categories,
  onClose,
  onSubmit,
}: {
  task: Task | null;
  people: Person[];
  peopleLoading: boolean;
  connectionsFailed: boolean;
  categories: string[];
  onClose: () => void;
  onSubmit: (values: TaskFormValues) => Promise<{ ok: boolean; fieldErrors?: Record<string, string> } | undefined>;
}) {
  const [values, setValues] = useState<TaskFormValues>(() => ({
    title: task?.title ?? "",
    description: task?.description ?? "",
    dueDate: toLocalInput(task?.dueDate ?? null),
    priority: task?.priority ?? "medium",
    category: task?.category ?? "General",
    status: task?.status ?? "todo",
    assigneeId: task?.assignee ? String(task.assignee.id) : "",
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!e[key as string]) return e;
      const next = { ...e };
      delete next[key as string];
      return next;
    });
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!values.title.trim()) next.title = "Give the task a title.";
    else if (values.title.trim().length > 140) next.title = "Keep the title under 140 characters.";
    if (values.dueDate && Number.isNaN(new Date(values.dueDate).getTime())) next.dueDate = "That date and time isn't valid.";
    if (!values.category.trim()) next.category = "Pick a category.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    const result = await onSubmit(values);
    setSaving(false);
    if (result && !result.ok) setErrors(result.fieldErrors ?? {});
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={task ? "Edit task" : "New task"}
      size="md"
      mobileSheet
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="task-form" loading={saving}>
            {task ? "Save changes" : "Create task"}
          </Button>
        </>
      }
    >
      <form id="task-form" onSubmit={save} className="space-y-4">
        <Input
          label="Title"
          value={values.title}
          onChange={(e) => set("title", e.target.value)}
          error={errors.title}
          placeholder="Follow up with the Kwartar retainer"
          autoFocus
          maxLength={160}
        />
        <Textarea
          label="Description"
          value={values.description}
          onChange={(e) => set("description", e.target.value)}
          error={errors.description}
          placeholder="Add context, links or the next concrete step"
          rows={3}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Due date"
            type="datetime-local"
            value={values.dueDate}
            onChange={(e) => set("dueDate", e.target.value)}
            error={errors.dueDate}
            hint="Leave empty for a someday list"
          />
          <Select
            label="Priority"
            value={values.priority}
            onChange={(e) => set("priority", e.target.value as Task["priority"])}
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
          <Select
            label="Category"
            value={values.category}
            onChange={(e) => set("category", e.target.value)}
            error={errors.category}
            options={categories.map((c) => ({ value: c, label: c }))}
          />
          <Select
            label="Assignee"
            value={values.assigneeId}
            onChange={(e) => set("assigneeId", e.target.value)}
            placeholder={connectionsFailed ? "Connections unavailable" : peopleLoading ? "Loading connections…" : "Nobody"}
            options={people.map((p) => ({ value: String(p.id), label: `${fullName(p)} — ${p.title || p.company}` }))}
            hint={connectionsFailed ? "Check your network page, then reopen this dialog." : peopleLoading ? undefined : "Pulled from your connections"}
          />
        </div>
        {task && (
          <Select
            label="Status"
            value={values.status}
            onChange={(e) => set("status", e.target.value as Task["status"])}
            options={[
              { value: "todo", label: "To do" },
              { value: "in_progress", label: "In progress" },
              { value: "done", label: "Done" },
            ]}
          />
        )}
        <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-xs text-ink-soft">
          <Clock size={14} className="mt-px shrink-0" aria-hidden />
          {values.dueDate
            ? `Shows in Today, Upcoming or Overdue based on ${new Date(values.dueDate).toLocaleString()}.`
            : "Without a due date this task stays in All until you schedule it."}
        </p>
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

function TasksSkeleton() {
  return (
    <div className="space-y-2.5" aria-label="Loading tasks">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="flex items-start gap-3 p-3.5">
          <Skeleton className="mt-0.5 h-6 w-6 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-2.5 w-5/6" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
          </div>
          <Skeleton className="h-8 w-14 rounded-lg" />
        </Card>
      ))}
    </div>
  );
}

/* Calendar day density comes from real task due dates — see dayMap above. */
