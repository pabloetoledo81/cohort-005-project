// The canned responses the payment simulator can give, chosen in the DevUI
// panel ("Refund payments"). Kept apart from payments.server.ts so the DevUI
// can list them without pulling server code into the client bundle.

export enum SimulatedRefundOutcome {
  Succeed = "succeed",
  Fail = "fail",
}

export const SIMULATED_REFUND_OUTCOMES = [
  { value: SimulatedRefundOutcome.Succeed, label: "Succeed" },
  { value: SimulatedRefundOutcome.Fail, label: "Fail" },
] as const;

export function parseSimulatedRefundOutcome(value: unknown): SimulatedRefundOutcome {
  return value === SimulatedRefundOutcome.Fail
    ? SimulatedRefundOutcome.Fail
    : SimulatedRefundOutcome.Succeed;
}
