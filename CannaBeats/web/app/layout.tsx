import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { cannabeatsPath } from "../lib/paths";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("host") ?? "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}${cannabeatsPath("/cannabeats-logo.jpg")}`;
  const title = "CannaBeats — Family Music Timeline";
  const description = "Listen, place the song in time, and build your family music timeline.";
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: image, width: 1200, height: 1200 }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
