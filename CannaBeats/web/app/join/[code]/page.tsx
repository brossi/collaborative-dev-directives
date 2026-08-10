import JoinRoom from "./join-room";

export const metadata = { referrer: "no-referrer" };

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <JoinRoom code={code.trim().toUpperCase()} />;
}
