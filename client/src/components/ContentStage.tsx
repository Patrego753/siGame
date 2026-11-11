import { useEffect, useRef, useState } from "react";
import type { ContentItem } from "@shared/gameTypes";

type Item = ContentItem & { mediaUrl?: string };

export function ContentStage({
  items,
  replic,
  playback = "controls",
  /** 0–1, общая громкость видео и всего звука */
  volumeMaster = 1,
  /** 0–1, множитель только для фоновой музыки (placement background) */
  volumeMusic = 1,
  /** tv: вписать картинку/видео в экран без обрезки */
  variant = "default",
  /** Увеличивать при переподключении сокета — повторный play() для медиа */
  mediaTick = 0,
}: {
  items: Item[];
  replic?: Item[];
  playback?: "controls" | "autoplay-all";
  volumeMaster?: number;
  volumeMusic?: number;
  variant?: "default" | "tv";
  mediaTick?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const screen = items.filter((i) => (i.placement || "screen") === "screen");
  const bg = items.filter((i) => i.placement === "background");
  const repl = replic ?? items.filter((i) => i.placement === "replic");

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const m = Math.min(1, Math.max(0, volumeMaster));
    const mus = Math.min(1, Math.max(0, volumeMusic));
    const apply = () => {
      root.querySelectorAll("[data-si-media]").forEach((node) => {
        const el = node as HTMLMediaElement;
        const pl = node.getAttribute("data-si-placement") || "screen";
        el.volume = pl === "background" ? m * mus : m;
      });
    };
    apply();
    if (playback === "autoplay-all") {
      root.querySelectorAll("video, audio").forEach((node) => {
        void (node as HTMLMediaElement).play().catch(() => {});
      });
      apply();
    }
  }, [items, replic, playback, volumeMaster, volumeMusic, mediaTick]);

  return (
    <div
      className={`content-stage${variant === "tv" ? " content-stage--tv" : ""}`}
      ref={rootRef}
    >
      {bg.map((it, i) => (
        <MediaBlock
          key={`bg-${i}`}
          item={it}
          className="content-bg"
          playback={playback}
        />
      ))}
      <div className="content-screen">
        {screen.map((it, i) => (
          <MediaBlock key={`sc-${i}`} item={it} playback={playback} />
        ))}
      </div>
      {repl.length > 0 && (
        <div className="content-replic">
          {repl.map((it, i) => (
            <MediaBlock key={`rp-${i}`} item={it} playback={playback} />
          ))}
        </div>
      )}
    </div>
  );
}

function MediaBlock({
  item,
  className,
  playback,
}: {
  item: Item;
  className?: string;
  playback: "controls" | "autoplay-all";
}) {
  const t = item.type?.toLowerCase() ?? "text";
  const v = item.value ?? "";
  const auto = playback === "autoplay-all";
  const placement = item.placement || "screen";
  const mediaFrameClass = `content-media-frame${className ? ` ${className}` : ""}`;

  if (t === "text" || t === "oral") {
    return (
      <div className={`content-text ${className ?? ""}`}>
        {v.split("\n").map((line: string, i: number) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    );
  }

  if (t === "image" && item.mediaUrl) {
    return (
      <div className={mediaFrameClass}>
        <img
          className="content-image"
          src={item.mediaUrl}
          alt=""
          loading={auto ? "eager" : "lazy"}
        />
      </div>
    );
  }

  if ((t === "audio" || t === "voice" || t === "sound") && item.mediaUrl) {
    return (
      <AudioBlock
        src={item.mediaUrl}
        className={className}
        auto={auto}
        placement={placement}
      />
    );
  }

  if (t === "video" && item.mediaUrl) {
    return (
      <div className={mediaFrameClass}>
        <video
          className="content-video"
          controls
          src={item.mediaUrl}
          playsInline
          muted={false}
          autoPlay={auto}
          preload="auto"
          data-si-media
          data-si-placement={placement}
        />
      </div>
    );
  }

  if (item.isRef && item.mediaUrl) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(v)) {
      return (
        <div className="content-media-frame">
          <img
            className="content-image"
            src={item.mediaUrl}
            alt=""
            loading={auto ? "eager" : "lazy"}
          />
        </div>
      );
    }
    if (/\.(mp3|ogg|wav)$/i.test(v)) {
      return (
        <AudioBlock src={item.mediaUrl} auto={auto} placement={placement} />
      );
    }
    if (/\.(mp4|webm)$/i.test(v)) {
      return (
        <div className="content-media-frame">
          <video
            className="content-video"
            controls
            src={item.mediaUrl}
            playsInline
            muted={false}
            autoPlay={auto}
            preload="auto"
            data-si-media
            data-si-placement={placement}
          />
        </div>
      );
    }
  }

  return (
    <div className="content-fallback mono">
      [{t}] {v.slice(0, 200)}
    </div>
  );
}

function AudioBlock({
  src,
  className,
  auto,
  placement,
}: {
  src: string;
  className?: string;
  auto: boolean;
  placement: string;
}) {
  const [playing, setPlaying] = useState(auto);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    
    // Ensure audio doesn't loop
    audio.loop = false;
    
    if (auto) {
      // Auto-play: start playing
      void audio.play().catch(() => {});
    } else {
      // Manual controls: pause on mount
      audio.pause();
      audio.currentTime = 0;
    }
  }, [auto]);

  return (
    <div className={`content-audio-wrap${className ? ` ${className}` : ""}`}>
      <div className={`content-audio-indicator${playing ? " is-playing" : ""}`} aria-live="polite">
        <div className="audio-visualizer">
          <div className="bar" />
          <div className="bar" />
          <div className="bar" />
          <div className="bar" />
          <div className="bar" />
          <div className="bar" />
          <div className="bar" />
          <div className="bar" />
        </div>
        <div className="audio-status-text">
          {playing ? "Воспроизведение аудио..." : "Аудио на паузе"}
        </div>
      </div>
      <audio
        ref={audioRef}
        controls={!auto}
        src={src}
        preload="auto"
        autoPlay={false}
        data-si-media
        data-si-placement={placement}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}
