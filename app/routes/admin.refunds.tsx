import { useEffect, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId, getDevRefundOutcome } from "~/lib/session";
import { simulatedPaymentProvider } from "~/lib/payments.server";
import { parseFormData } from "~/lib/validation";
import { RefundRequestStatus, RefundStatus, UserRole, users } from "~/db/schema";
import { db } from "~/db";
import { eq } from "drizzle-orm";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, Receipt } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";
import { formatPrice } from "~/lib/utils";
import {
  approveRefundRequest,
  declineRefundRequest,
  payRefund,
  retryRefund,
  listRefundRequestsForReview,
  type RefundRequestForReview,
} from "~/lib/refunds.server";
import { RULE_BREAK_LABELS } from "~/lib/refund-rules";

const refundFilterSchema = z
  .nativeEnum(RefundRequestStatus)
  .catch(RefundRequestStatus.Open);

const adminRefundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
    // Dollars, as typed. Only an Individual Purchase sends one; a Team
    // Licence is always refunded in full.
    amount: z
      .string()
      .trim()
      .optional()
      .transform((value, ctx) => {
        if (!value) return null;
        if (!/^\d+(\.\d{1,2})?$/.test(value)) {
          ctx.addIssue({ code: "custom", message: "Enter an amount like 40 or 39.50." });
          return z.NEVER;
        }
        return Math.round(Number(value) * 100);
      }),
    note: z
      .string()
      .trim()
      .max(1000, "Please keep the note under 1000 characters.")
      .optional(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    note: z
      .string()
      .trim()
      .min(1, "Write the buyer a note saying why it was declined.")
      .max(1000, "Please keep the note under 1000 characters."),
  }),
  z.object({
    intent: z.literal("retry"),
    refundId: z.coerce.number().int(),
  }),
]);

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** Only a Platform Admin decides Refund Requests. */
async function requirePlatformAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refunds.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only Platform Admins can review refund requests.", {
      status: 403,
    });
  }

  return currentUser;
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline refund requests" },
  ];
}

export async function loader({ request, url }: Route.LoaderArgs) {
  await requirePlatformAdmin(request);

  const status = refundFilterSchema.parse(url.searchParams.get("status"));

  return {
    status,
    refundRequests: listRefundRequestsForReview(db, status, new Date()),
  };
}

/**
 * What a decision or retry tells the Platform Admin. A payment that fails is
 * not a failed action: the approval or retry happened, so it is a warning.
 * Anything that stops the action throws (CODING_STANDARDS.md).
 */
type ActionOutcome = { tone: "success" | "warning"; message: string };

export async function action({ request }: Route.ActionArgs): Promise<ActionOutcome> {
  const platformAdmin = await requirePlatformAdmin(request);

  const parsed = parseFormData(await request.formData(), adminRefundActionSchema);
  if (!parsed.success) {
    throw data(Object.values(parsed.errors)[0] ?? "Invalid input.", { status: 400 });
  }

  const input = parsed.data;

  if (input.intent === "decline") {
    const result = declineRefundRequest(
      db,
      input.refundRequestId,
      platformAdmin.id,
      input.note,
      new Date()
    );
    if (!result.ok) throw data(result.error, { status: result.status });
    return { tone: "success", message: "Refund request declined." };
  }

  // Built before anything is approved, so a simulator that refuses to run
  // (in production) stops the approval instead of stranding a Refund.
  let provider;
  try {
    provider = simulatedPaymentProvider(await getDevRefundOutcome(request));
  } catch (error) {
    throw data(error instanceof Error ? error.message : String(error), {
      status: 503,
    });
  }

  if (input.intent === "retry") {
    const result = await retryRefund(db, provider, input.refundId, new Date());
    if (!result.ok) throw data(result.error, { status: result.status });
    return result.status === RefundStatus.Issued
      ? { tone: "success", message: "Refund issued." }
      : { tone: "warning", message: "The refund failed again. You can retry it." };
  }

  const approved = approveRefundRequest(
    db,
    input.refundRequestId,
    platformAdmin.id,
    input.amount,
    input.note || null,
    new Date()
  );
  if (!approved.ok) throw data(approved.error, { status: approved.status });

  // The approval has committed; now send the money.
  const paid = await payRefund(db, provider, approved.refundId, new Date());
  return paid.ok && paid.status === RefundStatus.Issued
    ? { tone: "success", message: "Refund request approved and the refund issued." }
    : {
        tone: "warning",
        message: "Refund request approved, but the refund failed. You can retry it.",
      };
}

const FILTERS: { status: RefundRequestStatus; label: string }[] = [
  { status: RefundRequestStatus.Open, label: "Open" },
  { status: RefundRequestStatus.Approved, label: "Approved" },
  { status: RefundRequestStatus.Declined, label: "Declined" },
];

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { status, refundRequests } = loaderData;
  const [, setSearchParams] = useSearchParams();

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or decline what buyers have asked for, oldest first.
        </p>
      </div>

      <div className="mb-6 flex gap-2">
        {FILTERS.map((filter) => (
          <Button
            key={filter.status}
            variant={filter.status === status ? "default" : "outline"}
            size="sm"
            onClick={() =>
              setSearchParams(
                filter.status === RefundRequestStatus.Open
                  ? {}
                  : { status: filter.status }
              )
            }
          >
            {filter.label}
          </Button>
        ))}
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <Receipt className="mx-auto mb-3 size-10 text-muted-foreground" />
            <p className="text-muted-foreground">
              No {status} refund requests.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((refundRequest) => (
            <RefundRequestCard
              key={refundRequest.id}
              refundRequest={refundRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function formatHours(seconds: number) {
  return `${(seconds / 3600).toFixed(1)}h`;
}

function Figures({
  refundRequest,
}: {
  refundRequest: RefundRequestForReview;
}) {
  const { figures } = refundRequest;

  const items =
    figures.kind === "individual_purchase"
      ? [
          { label: "Purchase", value: "Individual Purchase" },
          {
            label: "Lessons completed",
            value: `${figures.lessonsCompleted} / ${figures.lessonCount}`,
          },
          { label: "Watched", value: formatHours(figures.secondsWatched) },
        ]
      : [
          { label: "Purchase", value: "Team Licence" },
          {
            label: "Seats claimed",
            value: `${figures.claimedSeatCount} / ${figures.seatCount}`,
          },
        ];

  return (
    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
      <div>
        <dt className="text-muted-foreground">Paid</dt>
        <dd className="font-medium">{formatPrice(refundRequest.amountPaid)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Since purchase</dt>
        <dd className="font-medium">
          {refundRequest.daysSincePurchase}{" "}
          {refundRequest.daysSincePurchase === 1 ? "day" : "days"}
        </dd>
      </div>
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="font-medium">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RefundRequestCard({
  refundRequest,
}: {
  refundRequest: RefundRequestForReview;
}) {
  const fetcher = useFetcher<typeof action>();
  const [note, setNote] = useState("");
  const fullAmount = (refundRequest.amountPaid / 100).toFixed(2);
  const [amount, setAmount] = useState(fullAmount);
  const isSubmitting = fetcher.state !== "idle";
  const isOpen = refundRequest.status === RefundRequestStatus.Open;
  const isIndividual = refundRequest.kind === "individual_purchase";
  // Checked here so a typo is caught before the action, which throws.
  const amountCents = Math.round(Number(amount) * 100);
  const amountIsValid =
    !isIndividual ||
    (/^\d+(\.\d{1,2})?$/.test(amount.trim()) &&
      amountCents > 0 &&
      amountCents <= refundRequest.amountPaid);
  const isPartial = isIndividual && amountIsValid && amountCents < refundRequest.amountPaid;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.tone === "warning") {
      toast.warning(fetcher.data.message);
    } else {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.state, fetcher.data]);

  function decide(intent: "approve" | "decline") {
    fetcher.submit(
      {
        intent,
        refundRequestId: String(refundRequest.id),
        note,
        // A Team Licence is always refunded in full, so it sends no amount.
        ...(intent === "approve" && isIndividual ? { amount } : {}),
      },
      { method: "post" }
    );
  }

  function retry(refundId: number) {
    fetcher.submit(
      { intent: "retry", refundId: String(refundId) },
      { method: "post" }
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              to={`/courses/${refundRequest.courseSlug}`}
              className="font-semibold hover:underline"
            >
              {refundRequest.courseTitle}
            </Link>
            <p className="text-sm text-muted-foreground">
              {refundRequest.buyerName} · {refundRequest.buyerEmail} · raised{" "}
              {new Date(refundRequest.requestedAt).toLocaleDateString()}
            </p>
          </div>
          {refundRequest.ruleBreaks.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {refundRequest.ruleBreaks.map((ruleBreak) => (
                <span
                  key={ruleBreak}
                  className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                >
                  <AlertTriangle className="size-3" />
                  {RULE_BREAK_LABELS[ruleBreak]}
                </span>
              ))}
            </div>
          )}
        </div>

        <Figures refundRequest={refundRequest} />

        <blockquote className="border-l-2 pl-3 text-sm">
          {refundRequest.reason}
        </blockquote>

        {isOpen ? (
          <div className="space-y-2 border-t pt-4">
            {isIndividual ? (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Refund amount $</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-28 rounded-md border bg-background px-2 py-1"
                  aria-label="Refund amount in dollars"
                />
                <span className="text-xs text-muted-foreground">
                  up to {formatPrice(refundRequest.amountPaid)}
                </span>
              </label>
            ) : null}
            {isIndividual && !amountIsValid ? (
              <p className="text-xs text-destructive">
                Enter an amount above $0 and up to{" "}
                {formatPrice(refundRequest.amountPaid)}, like 40 or 39.50. To
                return nothing, decline it.
              </p>
            ) : null}
            {isIndividual ? null : (
              <p className="text-sm text-muted-foreground">
                A Team Licence is refunded in full:{" "}
                {formatPrice(refundRequest.amountPaid)}.
              </p>
            )}
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder={
                isPartial
                  ? "A note to the buyer. Required for a partial refund."
                  : "A note to the buyer. Required to decline."
              }
            />
            {!refundRequest.canApprove && (
              <p className="text-xs text-muted-foreground">
                A Seat on this Team Licence has been claimed, so it can only be
                declined.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => decide("approve")}
                disabled={
                  isSubmitting ||
                  !refundRequest.canApprove ||
                  !amountIsValid ||
                  (isPartial && note.trim().length === 0)
                }
              >
                {isPartial ? "Approve partial refund" : "Approve"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => decide("decline")}
                disabled={isSubmitting || note.trim().length === 0}
              >
                Decline
              </Button>
            </div>
          </div>
        ) : (
          <div className="border-t pt-4 text-sm text-muted-foreground">
            {refundRequest.status === RefundRequestStatus.Approved
              ? "Approved"
              : "Declined"}
            {refundRequest.decidedByName &&
              ` by ${refundRequest.decidedByName}`}
            {refundRequest.resolvedAt &&
              ` on ${new Date(refundRequest.resolvedAt).toLocaleDateString()}`}
            {refundRequest.decisionNote && (
              <p className="mt-2 rounded-md bg-muted p-2 text-foreground">
                {refundRequest.decisionNote}
              </p>
            )}
            {refundRequest.refund && (
              <RefundState
                refund={refundRequest.refund}
                amountPaid={refundRequest.amountPaid}
                isSubmitting={isSubmitting}
                onRetry={retry}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const REFUND_STATUS_LABELS: Record<RefundStatus, { label: string; className: string }> = {
  [RefundStatus.Pending]: {
    label: "Refund pending",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  },
  [RefundStatus.Issued]: {
    label: "Refund issued",
    className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  },
  [RefundStatus.Failed]: {
    label: "Refund failed",
    className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  },
};

/** The money side of an Approved Refund Request, with Retry when allowed. */
function RefundState({
  refund,
  amountPaid,
  isSubmitting,
  onRetry,
}: {
  refund: NonNullable<RefundRequestForReview["refund"]>;
  amountPaid: number;
  isSubmitting: boolean;
  onRetry: (refundId: number) => void;
}) {
  const badge = REFUND_STATUS_LABELS[refund.status];
  return (
    <div className="mt-3 space-y-2 text-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
          {badge.label}
        </span>
        <span>
          {formatPrice(refund.approvedAmount)}
          {refund.approvedAmount < amountPaid &&
            ` of ${formatPrice(amountPaid)} (partial)`}
        </span>
        {refund.attempts > 1 && (
          <span className="text-xs text-muted-foreground">
            {refund.attempts} attempts
          </span>
        )}
      </div>
      {refund.status === RefundStatus.Failed && refund.failureReason && (
        <p className="text-xs text-muted-foreground">{refund.failureReason}</p>
      )}
      {refund.canRetry && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRetry(refund.id)}
          disabled={isSubmitting}
        >
          Retry refund
        </Button>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have permission to access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
