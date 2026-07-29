import Link from "next/link";
import { routes } from "@/src/lib/routes";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <Link href={routes.clients()} className="text-sm text-primary underline">
        Back to clients
      </Link>
    </div>
  );
}
