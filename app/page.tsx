import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Product Video Pipeline</h1>
      <p className="text-muted-foreground">
        Adapter-centric, human-reviewed reel generation — Nano Banana, Veo 3.1, HeyGen Cinematic Avatar, Higgsfield.
      </p>
      <div className="flex gap-4">
        <Link href="/dashboard" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          Dashboard
        </Link>
        <Link href="/clients" className="rounded-md border px-4 py-2 text-sm font-medium">
          Clients
        </Link>
      </div>
    </main>
  );
}
