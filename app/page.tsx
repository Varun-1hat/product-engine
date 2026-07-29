import { redirect } from "next/navigation";
import { routes } from "@/src/lib/routes";

export default function RootPage() {
  redirect(routes.clients());
}
