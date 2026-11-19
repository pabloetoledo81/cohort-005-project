import { RefundStatus } from "~/db/schema";
import { formatPrice } from "~/lib/utils";

// What a buyer sees of the money after their Refund Request is approved. Kept
// apart from the request's own status, so "Approved" never reads as "the
// money was sent" and "Failed" never reads as "Declined".

const BUYER_REFUND_LABELS: Record<
  RefundStatus,
  { label: string; detail: string; className: string }
> = {
  [RefundStatus.Pending]: {
    label: "Refund pending",
    detail: "We're sending it.",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  },
  [RefundStatus.Issued]: {
    label: "Refund issued",
    detail: "The money has been sent back to you.",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  },
  [RefundStatus.Failed]: {
    label: "Refund failed",
    detail: "We couldn't send your refund; we're on it.",
    className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  },
};

export function BuyerRefundStatus({
  refund,
  amountPaid,
}: {
  refund: { status: RefundStatus; approvedAmount: number };
  amountPaid: number;
}) {
  const state = BUYER_REFUND_LABELS[refund.status];
  const partial = refund.approvedAmount < amountPaid;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span
        className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${state.className}`}
      >
        {state.label}
      </span>
      <span>
        {formatPrice(refund.approvedAmount)}
        {partial && ` of the ${formatPrice(amountPaid)} you paid`}
      </span>
      <span className="text-muted-foreground">{state.detail}</span>
    </div>
  );
}
