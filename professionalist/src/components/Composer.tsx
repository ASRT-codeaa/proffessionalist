import { useRef, useState } from "react";
import {
  Calendar,
  Image as ImageIcon,
  Link2,
  MapPin,
  MessageSquareOff,
  BarChart3,
  ShoppingBag,
  Sparkles,
  X,
} from "lucide-react";
import { Avatar, Button, Card, Input, Modal, Select, Switch, Textarea } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { errorMessage } from "@/hooks/useAsync";
import { postsApi } from "@/services/api";
import { mediaUrl } from "@/services/http";
import type { MediaItem } from "@/services/types";
import { cn, fullName } from "@/lib/utils";

type Attachment = "image" | "poll" | "product" | "link" | "schedule";

const KINDS = [
  { id: "product", label: "Product", icon: ShoppingBag },
  { id: "service", label: "Service", icon: Sparkles },
  { id: "job", label: "Opportunity", icon: Calendar },
] as const;

export function Composer({ onPosted }: { onPosted: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [kind, setKind] = useState<"post" | "product" | "service" | "job">("post");
  const [audience, setAudience] = useState<"public" | "connections">("public");
  const [location, setLocation] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [commentsDisabled, setCommentsDisabled] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [panel, setPanel] = useState<Attachment | null>(null);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [busy, setBusy] = useState(false);

  if (!user) return null;
  const name = fullName(user);
  const hashtags = [...text.matchAll(/#([\w-]+)/g)].map((m) => m[1]);

  const reset = () => {
    setText("");
    setMedia([]);
    setKind("post");
    setLocation("");
    setLinkUrl("");
    setCommentsDisabled(false);
    setScheduledAt("");
    setPollQuestion("");
    setPollOptions(["", ""]);
    setPanel(null);
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const r = await postsApi.uploadMedia([...files]);
      setMedia((prev) => [...prev, ...r.urls]);
      setPanel(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const body = text.trim();
    if (!body && !media.length && !linkUrl) {
      toast.error("Write something or attach media first.");
      return;
    }
    if (panel === "poll" && pollOptions.filter((o) => o.trim()).length < 2) {
      toast.error("A poll needs at least two options.");
      return;
    }
    setBusy(true);
    try {
      await postsApi.create({
        text: body,
        kind,
        media,
        linkUrl: linkUrl || undefined,
        audience,
        location: location || undefined,
        hashtags,
        commentsDisabled,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        poll:
          panel === "poll" && pollQuestion.trim()
            ? { question: pollQuestion.trim(), options: pollOptions.map((o) => o.trim()).filter(Boolean) }
            : null,
      });
      reset();
      setOpen(false);
      onPosted();
      toast.success(scheduledAt ? "Post scheduled" : "Posted to your feed");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const attach = (a: Attachment) => {
    if (a === "image") {
      fileRef.current?.click();
      return;
    }
    setPanel((prev) => (prev === a ? null : a));
  };

  return (
    <>
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <Avatar name={name} src={user.profile.avatarUrl} size="md" />
          <button
            onClick={() => setOpen(true)}
            className="h-11 flex-1 rounded-full border border-line bg-surface-2/60 px-4 text-left text-sm text-ink-soft transition-colors hover:bg-surface-2"
          >
            What are you working on, {user.firstName}?
          </button>
        </div>
        <div className="mt-3 grid grid-cols-5 gap-1 border-t border-line pt-2">
          <ComposerTrigger icon={ImageIcon} label="Photo" onClick={() => attach("image")} />
          <ComposerTrigger icon={BarChart3} label="Poll" onClick={() => { setOpen(true); attach("poll"); }} />
          <ComposerTrigger icon={Link2} label="Link" onClick={() => { setOpen(true); attach("link"); }} />
          <ComposerTrigger icon={ShoppingBag} label="Product" onClick={() => { setOpen(true); attach("product"); }} />
          <ComposerTrigger icon={Calendar} label="Schedule" onClick={() => { setOpen(true); attach("schedule"); }} />
        </div>
      </Card>

      <input ref={fileRef} type="file" accept="image/*,video/mp4,application/pdf" multiple hidden onChange={(e) => void pickFiles(e.target.files)} />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        mobileSheet
        title="Create a post"
        footer={
          <>
            <Select
              aria-label="Audience"
              className="!h-9 w-auto mr-auto"
              value={audience}
              onChange={(e) => setAudience(e.target.value as "public" | "connections")}
              options={[
                { value: "public", label: "🌐 Public" },
                { value: "connections", label: "🔒 Connections" },
              ]}
            />
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => void submit()} loading={busy}>
              {scheduledAt ? "Schedule" : "Post"}
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-3">
          <Avatar name={name} src={user.profile.avatarUrl} size="md" />
          <div>
            <p className="text-sm font-bold">{name}</p>
            <div className="flex items-center gap-2">
              <Select
                aria-label="Post type"
                className="!h-7 w-auto !text-xs"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
                options={[{ value: "post", label: "Standard post" }, ...KINDS.map((k) => ({ value: k.id, label: k.label }))]}
              />
            </div>
          </div>
        </div>

        <Textarea
          rows={5}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Share an update, an insight, or an opportunity…"
          className="mt-3 text-[15px]"
          aria-label="Post text"
        />

        {media.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {media.map((m) => (
              <div key={m.url} className="relative overflow-hidden rounded-xl border border-line">
                {m.type === "document" ? (
                  <div className="flex h-24 items-center justify-center bg-surface-2 px-2 text-center text-xs font-semibold">{m.name}</div>
                ) : (
                  <img src={mediaUrl(m.url)} alt="" className="h-24 w-full object-cover" />
                )}
                <button
                  onClick={() => setMedia((prev) => prev.filter((x) => x.url !== m.url))}
                  aria-label="Remove attachment"
                  className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {panel === "poll" && (
          <div className="mt-3 space-y-2 rounded-xl border border-line p-3">
            <Input label="Poll question" value={pollQuestion} onChange={(e) => setPollQuestion(e.target.value)} placeholder="What should we decide?" />
            {pollOptions.map((o, i) => (
              <Input
                key={i}
                aria-label={`Option ${i + 1}`}
                value={o}
                placeholder={`Option ${i + 1}`}
                onChange={(e) => setPollOptions((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
              />
            ))}
            <div className="flex gap-2">
              {pollOptions.length < 5 && (
                <Button size="sm" variant="outline" onClick={() => setPollOptions((p) => [...p, ""])}>
                  Add option
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>Remove poll</Button>
            </div>
          </div>
        )}

        {panel === "link" && (
          <div className="mt-3">
            <Input label="Link" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://example.com/article" />
          </div>
        )}

        {panel === "schedule" && (
          <div className="mt-3">
            <Input label="Publish at" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </div>
        )}

        {panel === "product" && (
          <p className="mt-3 rounded-xl bg-accent-soft p-3 text-sm text-accent">
            To attach a live listing, publish it from the Marketplace first, then share it from its page.
          </p>
        )}

        <div className="mt-3 space-y-2">
          <Input
            aria-label="Location"
            icon={<MapPin size={15} />}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Add location"
          />
          <div className="flex items-center justify-between rounded-xl border border-line px-3.5 py-2.5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <MessageSquareOff size={16} /> Turn off comments
            </span>
            <Switch checked={commentsDisabled} onChange={setCommentsDisabled} label="Disable comments" />
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-line bg-surface-2/50 p-3">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">Live preview</p>
          <p className="text-sm whitespace-pre-wrap">{text || "Your post will appear here as you type."}</p>
          {hashtags.length > 0 && (
            <p className="mt-1.5 text-sm font-semibold text-accent">{hashtags.map((h) => `#${h}`).join(" ")}</p>
          )}
        </div>
      </Modal>
    </>
  );
}

function ComposerTrigger({ icon: Icon, label, onClick }: { icon: typeof ImageIcon; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 rounded-lg py-2 text-[11px] font-semibold text-ink-soft transition-colors hover:bg-surface-2 hover:text-accent sm:flex-row sm:justify-center sm:gap-2 sm:text-[13px]"
      )}
    >
      <Icon size={17} />
      {label}
    </button>
  );
}
