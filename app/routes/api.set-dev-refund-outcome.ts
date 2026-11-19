import { redirect } from "react-router";
import type { Route } from "./+types/api.set-dev-refund-outcome";
import { setDevRefundOutcome } from "~/lib/session";
import { parseSimulatedRefundOutcome } from "~/lib/payment-simulator";

// The DevUI panel's "Refund payments" setting: whether the payment simulator
// issues or fails the Refunds this session sends.
export async function action({ request, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const outcome = parseSimulatedRefundOutcome(formData.get("outcome"));

  const cookie = await setDevRefundOutcome(request, outcome);

  return redirect(url.searchParams.get("redirectTo") ?? "/", {
    headers: { "Set-Cookie": cookie },
  });
}
