export type LinkEmbed = {
  provider: "youtube" | "vimeo";
  videoId: string;
  embedUrl: string;
  thumbUrl: string | null;
  canonicalUrl: string;
};

/**
 * Client mirror of the server's provider allowlist (app-new/services/videoKit.js PROVIDERS,
 * youtubeId and the vimeo canonical): five YouTube spellings and two Vimeo ones resolve to an
 * embeddable id; everything else returns null and renders as a plain link card.
 */
export function classifyLink(raw: string): LinkEmbed | null {
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
    const id = youtubeId(url);
    if (!id) return null;
    return {
      provider: "youtube",
      videoId: id,
      embedUrl: `https://www.youtube.com/embed/${id}`,
      thumbUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    };
  }

  if (host === "vimeo.com") {
    const m = /^\/(?:video\/)?(\d{4,})/.exec(url.pathname);
    if (!m) return null;
    return {
      provider: "vimeo",
      videoId: m[1],
      embedUrl: `https://player.vimeo.com/video/${m[1]}`,
      thumbUrl: null,
      canonicalUrl: `https://vimeo.com/${m[1]}`,
    };
  }

  return null;
}

function youtubeId(url: URL): string | null {
  if (url.hostname.toLowerCase().replace(/^www\./, "") === "youtu.be") {
    const m = /^\/([A-Za-z0-9_-]{6,20})/.exec(url.pathname);
    return m ? m[1] : null;
  }
  const param = url.searchParams.get("v");
  if (param && /^[A-Za-z0-9_-]{6,20}$/.test(param)) return param;
  const m = /^\/(shorts|embed|live)\/([A-Za-z0-9_-]{6,20})/.exec(url.pathname);
  return m ? m[2] : null;
}

/** The tap has happened by the time we build this src, so autoplay is earned, not requested cold. */
export function embedSrcForPlay(embed: string, provider: LinkEmbed["provider"]): string {
  try {
    const url = new URL(embed);
    url.searchParams.set("autoplay", "1");
    if (provider === "vimeo") {
      url.searchParams.set("title", "0");
      url.searchParams.set("byline", "0");
      url.searchParams.set("portrait", "0");
    }
    return url.toString();
  } catch {
    return embed;
  }
}
