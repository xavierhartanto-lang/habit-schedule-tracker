"use client";

import { cn } from "@/lib/utils/cn";
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Moon,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Subtle current weather beside the date. Open-Meteo: free, no API key,
 * called from the browser so nothing about the user reaches our server.
 *
 * Where: a precise location if the user already allowed it (or taps the
 * weather to allow it), otherwise the city in their time zone's name
 * ("America/Los_Angeles" -> Los Angeles), which is close enough for a
 * glance. Anything that fails just hides the weather.
 */

type Place = { lat: number; lon: number; name: string | null; precise: boolean };
type Now = { temp: number; code: number; isDay: boolean; unit: "F" | "C" };

const PLACE_KEY = "ws:weather:place";
const NOW_KEY = "ws:weather:now";
const FRESH_MS = 30 * 60_000;

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage off: the weather still shows, it just refetches.
  }
}

/** Fahrenheit where people expect it, Celsius everywhere else. */
function unitFor(locale: string): "F" | "C" {
  const region = locale.split("-")[1]?.toUpperCase();
  return region && ["US", "LR", "MM", "BS", "BZ", "KY", "PW"].includes(region) ? "F" : "C";
}

/** "America/Argentina/Buenos_Aires" -> "Buenos Aires". Null for zones that aren't a city. */
export function cityFromTimeZone(tz: string): string | null {
  if (!tz.includes("/") || tz.startsWith("Etc/")) return null;
  const city = tz.split("/").at(-1)!.replace(/_/g, " ");
  return city.length > 1 ? city : null;
}

async function placeFromTimeZone(tz: string, signal: AbortSignal): Promise<Place | null> {
  const city = cityFromTimeZone(tz);
  if (!city) return null;
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
    { signal },
  );
  if (!res.ok) return null;
  const hit = ((await res.json()) as { results?: { latitude: number; longitude: number; name: string }[] }).results?.[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude, name: hit.name, precise: false } : null;
}

function precisePlace(): Promise<Place | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      // Two decimals (~1 km) is plenty for weather, and all we keep.
      (p) =>
        resolve({ lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100, name: null, precise: true }),
      () => resolve(null),
      { maximumAge: 60 * 60_000, timeout: 10_000 },
    );
  });
}

async function alreadyAllowed(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: "geolocation" })).state === "granted";
  } catch {
    return false;
  }
}

async function fetchNow(place: Place, unit: "F" | "C", signal: AbortSignal): Promise<Now | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,weather_code,is_day&timezone=auto` +
    (unit === "F" ? "&temperature_unit=fahrenheit" : "");
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const c = ((await res.json()) as { current?: { temperature_2m: number; weather_code: number; is_day: number } }).current;
  return c ? { temp: Math.round(c.temperature_2m), code: c.weather_code, isDay: c.is_day === 1, unit } : null;
}

/** WMO weather codes, folded into a few calm words. */
export function describe(code: number, isDay: boolean): { label: string; icon: LucideIcon } {
  if (code === 0) return { label: "Clear", icon: isDay ? Sun : Moon };
  if (code <= 2) return { label: "Partly cloudy", icon: isDay ? CloudSun : CloudMoon };
  if (code === 3) return { label: "Cloudy", icon: Cloud };
  if (code === 45 || code === 48) return { label: "Fog", icon: CloudFog };
  if (code >= 51 && code <= 57) return { label: "Drizzle", icon: CloudDrizzle };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: "Rain", icon: CloudRain };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: "Snow", icon: CloudSnow };
  if (code >= 95) return { label: "Storms", icon: CloudLightning };
  return { label: "Cloudy", icon: Cloud };
}

export function Weather({ timeZone, className }: { timeZone: string; className?: string }) {
  const [place, setPlace] = useState<Place | null>(null);
  const [now, setNow] = useState<Now | null>(null);

  const load = useCallback(
    async (signal: AbortSignal, forced?: Place) => {
      const unit = unitFor(navigator.language || "en-US");
      let p = forced ?? read<Place>(PLACE_KEY);
      if (!p && (await alreadyAllowed())) p = await precisePlace();
      if (!p) p = await placeFromTimeZone(timeZone, signal);
      if (!p || signal.aborted) return;
      write(PLACE_KEY, p);
      setPlace(p);

      const cached = read<Now & { at: number; lat: number; lon: number }>(NOW_KEY);
      if (!forced && cached && cached.unit === unit && cached.lat === p.lat && cached.lon === p.lon && Date.now() - cached.at < FRESH_MS) {
        setNow(cached);
        return;
      }
      const fresh = await fetchNow(p, unit, signal);
      if (!fresh || signal.aborted) return;
      write(NOW_KEY, { ...fresh, at: Date.now(), lat: p.lat, lon: p.lon });
      setNow(fresh);
    },
    [timeZone],
  );

  useEffect(() => {
    const controller = new AbortController();
    // Off the render path: storage reads and fetches happen after paint.
    const id = window.setTimeout(() => void load(controller.signal).catch(() => undefined), 0);
    return () => {
      window.clearTimeout(id);
      controller.abort();
    };
  }, [load]);

  if (!now) return null;
  const { label, icon: Icon } = describe(now.code, now.isDay);
  const where = place?.precise ? "your location" : (place?.name ?? "your area");

  return (
    <button
      type="button"
      disabled={place?.precise}
      onClick={async () => {
        const p = await precisePlace();
        if (p) await load(new AbortController().signal, p).catch(() => undefined);
      }}
      title={place?.precise ? `Weather at ${where}` : `Weather near ${where}. Tap to use your precise location.`}
      aria-label={`${now.temp}°${now.unit}, ${label}, near ${where}`}
      className={cn(
        "inline-flex animate-fade-in items-center gap-1.5 rounded-full text-ink-3 tabular-nums transition-colors enabled:hover:text-ink-2 disabled:cursor-default",
        className,
      )}
    >
      <span aria-hidden className="mr-1 size-[3px] rounded-full bg-ink-3/50" />
      <Icon aria-hidden className="size-[15px] shrink-0" strokeWidth={1.9} />
      <span>{now.temp}°</span>
      <span className="max-sm:hidden">{label}</span>
    </button>
  );
}
