import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.set-dev-refund-outcome";
import { setDevRefundOutcome } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { SimulatedRefundOutcome } from "~/lib/payment-simulator";

// The DevUI panel's "Refund payments" setting: whether the payment simulator
// issues or fails the Refunds this session sends.

const setDevRefundOutcomeSchema = z.object({
  outcome: z.nativeEnum(SimulatedRefundOutcome),
});

export async function action({ request, url }: Route.ActionArgs) {
  const parsed = parseFormData(await request.formData(), setDevRefundOutcomeSchema);
  if (!parsed.success) {
    throw data("Choose Succeed or Fail.", { status: 400 });
  }

  const cookie = await setDevRefundOutcome(request, parsed.data.outcome);

  return redirect(url.searchParams.get("redirectTo") ?? "/", {
    headers: { "Set-Cookie": cookie },
  });
}
