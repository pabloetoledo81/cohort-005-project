import { SimulatedRefundOutcome } from "~/lib/payment-simulator";

export { SimulatedRefundOutcome };

// ─── Payments ───
// Sending a Refund's money goes through this interface, so a real payment
// provider can replace the simulator without changing the Refund workflow.
//
// The Refund's id is the idempotency key: a real provider must refuse to pay
// the same Refund twice, however many times it is retried.

export type RefundPayment = {
  refundId: number;
  purchaseId: number;
  /** In cents. The whole approved amount: a Refund is sent in one go. */
  amount: number;
};

export type RefundPaymentResult =
  | { status: "issued"; providerReference: string }
  | { status: "failed"; reason: string };

export interface PaymentProvider {
  refund(payment: RefundPayment): Promise<RefundPaymentResult>;
}

// ─── The simulator ───
// The only provider today. It is deterministic: it returns whichever canned
// response is chosen in the DevUI panel ("Refund payments"), so both paths can
// be exercised on demand. It moves no money, so it refuses to run in
// production unless ALLOW_PAYMENT_SIMULATOR=true says that's intended.

export const SIMULATED_FAILURE_REASON =
  "The card issuer declined the refund (simulated).";

export function simulatedPaymentProvider(
  outcome: SimulatedRefundOutcome
): PaymentProvider {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PAYMENT_SIMULATOR !== "true"
  ) {
    throw new Error(
      "The payment simulator moves no money, so it won't run in production. " +
        "Configure a real payment provider, or set ALLOW_PAYMENT_SIMULATOR=true " +
        "if fake refunds are really intended."
    );
  }

  return {
    async refund(payment) {
      if (outcome === SimulatedRefundOutcome.Fail) {
        return { status: "failed", reason: SIMULATED_FAILURE_REASON };
      }
      return {
        status: "issued",
        providerReference: `sim_refund_${payment.refundId}`,
      };
    },
  };
}
