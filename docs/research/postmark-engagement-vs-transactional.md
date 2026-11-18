# Postmark rules for engagement vs transactional email

Research for issue #8 (child of map #2, "Wayfinder: Notifications spec").

**Question:** Postmark's requirements and recommendations for engagement email versus transactional email. This covers message streams (transactional or broadcast), List-Unsubscribe and one-click unsubscribe headers, and the Gmail and Yahoo sender rules. It also asks whether a Notification like "an Instructor replied to your Comment" counts as transactional.

**Context:** The ticket says Cadence sends through Postmark's default `outbound` (transactional) stream, with `TextBody` only, via `app/lib/mailer.server.ts`. That file does not exist in this checkout, and a search of `app/` for `postmark` or `MessageStream` found nothing, so I could not check the current setup.

## TL;DR

1. **Reply-to-your-Comment Notifications and refund decisions go on the transactional stream.** Postmark defines transactional email as "email triggered by some kind of user action". Its own examples include **"Comment notifications"** and "Weekly digest emails" [P2]. Refund decisions are closest to the "billing updates" and "purchase confirmations" rows, which Postmark classes as transactional [P3].
2. **Watched-time milestones are a gray area.** No Postmark source mentions milestones. Two things point to transactional: they are automatic, and they come from the learner's own activity. Two things point to broadcast: they are not urgent, and they look like engagement nudges the recipient could opt out of [P3]. Classifying them is my inference, not Postmark guidance. Keep them on the transactional stream only while they stay one-to-one, triggered by an event and expected by the learner. Anything batched, scheduled or promotional (digests of recommendations, "come back" nudges) belongs on a broadcast stream.
3. **Transactional stream: unsubscribe headers are optional.** Postmark passes through any List-Unsubscribe headers you set [P4]. Gmail says one-click unsubscribe "is required only for marketing and promotional messages. Transactional messages are excluded" [G2]. Even so, I recommend offering preferences and a List-Unsubscribe header on engagement Notifications. Recipients mark unwanted mail as spam, which counts against the Gmail and Yahoo 0.3% ceiling [G1][Y1]. Gmail adds that "Message recipients, not Google, determine the nature of the messages they receive" [G2].
4. **Broadcast stream: Postmark handles unsubscribes by default.** It adds a body unsubscribe link and the RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers, and suppresses anyone who unsubscribes. Those headers cannot be edited while Postmark manages unsubscribes. Managing them yourself needs Postmark support's approval and makes you responsible for both the link and the headers [P4][P5].
5. **Gmail and Yahoo bulk-sender rules apply above about 5,000 messages a day to their users.** Bulk senders need SPF, DKIM and DMARC (`p=none` is enough), a From: domain that aligns with SPF or DKIM, RFC 8058 one-click unsubscribe and a visible body link on marketing and subscribed mail, unsubscribes honoured within 2 days (Yahoo's rule), and a spam rate under 0.3% (Gmail's target is under 0.1%). Bulk status in Gmail is permanent once it is reached [G1][G2][Y1].

## 1. Message streams in Postmark

- Transactional streams are "for one-to-one emails triggered by a user action", such as password resets, receipts and shipping updates. Broadcast streams are "for one-to-many sends", such as policy updates, product announcements and newsletters [P1].
- "Broadcast traffic uses dedicated infrastructure so transactional delivery stays fast and reliable" [P1]. Engagement mail that recipients ignore therefore cannot drag down transactional reputation, provided it goes on a broadcast stream.
- The default stream is the transactional one. To use any other stream you must name it, with `MessageStream` in the API or the `X-PM-Message-Stream` header over SMTP [P1].
- Postmark's definition: "We define transactional email as email triggered by some kind of user action." Its examples are welcome, password reset, **comment notifications**, **weekly digest emails**, order confirmation and tracking, and receipts and invoices [P2].
- Postmark's comparison chart sorts messages by their characteristics [P3]:
  - **Points to transactional:** sent automatically with no human intervention; sent immediately after the recipient acts; urgent, or needs the recipient to act; legally, practically or contractually required; time-sensitive (delivered within 10 minutes).
  - **Points to broadcast:** a human writes or schedules it; content changes with each send; sent to a stored list or to many recipients at once; recipients can choose not to receive it; low engagement expected (under 20% opens).
  - The chart says some types "blur the line". Activity digests appear on both sides: broadcast on several rows (stored list, opt-out, low engagement) and transactional on one (automatic) [P3]. This conflicts with [P2], which calls weekly digests transactional. Treat digests as a gray area.

### Applying this to Cadence (inference, not Postmark guidance)

| Email                                     | Stream                            | Reason                                                                                                                                                                      |
| ----------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructor replied to your Comment        | Transactional                     | Postmark lists "Comment notifications" as transactional [P2]. Automatic, one-to-one, and follows the learner's own action [P3].                                             |
| Refund decision (approved or denied)      | Transactional                     | Closest to billing updates and purchase confirmations, which are transactional and practically required [P3].                                                              |
| Watched-time milestone                    | Transactional (gray area)         | Automatic, one-to-one and triggered by an event, but not urgent and can be opted out of [P3]. Move it to broadcast if it becomes batched or promotional.                   |
| Digest or recap of activity               | Broadcast preferred (gray area)   | Postmark sources conflict [P2][P3]. Broadcast keeps opens below 20% away from transactional reputation.                                                                   |
| Course announcements, marketing, re-engagement | Broadcast                    | A human writes it, it goes to a list, and it is promotional [P1][P3].                                                                                                      |

## 2. Unsubscribe requirements

### Postmark

- **Transactional streams:** unsubscribe links and headers are not required. "If you add Unsubscribe headers to transactional messages, Postmark will include them in your send." Set them through the API `Headers` array as `Name` and `Value` pairs, for example `List-Unsubscribe-Post: List-Unsubscribe=One-Click` plus `List-Unsubscribe: <mailto:...>, <https://...>` [P4].
- **Broadcast streams, default ("Manage unsubscribes with Postmark"):** Postmark adds a one-click unsubscribe link to the bottom of every message, adds the one-click `List-Unsubscribe-Post` and `List-Unsubscribe` headers, and suppresses recipients who unsubscribe. "There is not a way to edit the List-Unsubscribe headers when Postmark is managing your unsubscribes" [P4].
- **Broadcast streams, managing your own unsubscribes:** this needs Postmark support's approval. You must "include a working unsubscribe link in every broadcast message you send" and add the headers yourself, because "Postmark no longer includes these headers for you". You are "fully responsible" for complying with the law [P5].
- **Not confirmed:** Postmark's search snippets say unsubscribes are scoped to the stream the message came from. The article I fetched [P4] does not state this. Confirm it with Postmark support before relying on it.

### RFC 8058 (one-click)

- `List-Unsubscribe` "MUST contain one HTTPS URI". It may also include others, such as mailto. `List-Unsubscribe-Post` must contain only `List-Unsubscribe=One-Click` [R1].
- The message needs a valid DKIM signature, and "The List-Unsubscribe and List-Unsubscribe-Post headers MUST be covered by the signature". Without that, receivers "SHOULD NOT offer a one-click unsubscribe" [R1].
- The receiver POSTs `List-Unsubscribe=One-Click` to the HTTPS URI with no cookies or auth. "The mail sender MUST NOT return an HTTPS redirect." The URI should identify the recipient and list with a hard-to-forge token [R1].
- **For Cadence:** an endpoint you host yourself (only needed for transactional mail, since broadcast is handled by Postmark) must accept an unauthenticated POST, find the user from a signed token in the URL, and respond without redirecting.

### Gmail

- **All senders:** SPF or DKIM, valid forward and reverse DNS, TLS, RFC 5322 formatting, and a spam rate under 0.3% [G1].
- **Bulk senders (about 5,000 or more a day to personal Gmail accounts):** SPF, DKIM and DMARC (`p=none` allowed), and a From: domain aligned with SPF or DKIM. "Marketing messages and subscribed messages must support one-click unsubscribe, and include a clearly visible unsubscribe link in the message body" [G1]. The page's heading says "5,000 or more" while its body says "more than 5,000".
- **Spam rate:** keep it below 0.10% and avoid ever reaching 0.30% [G1].
- **Transactional exclusion:** "One-click unsubscribe is required only for marketing and promotional messages. Transactional messages are excluded from this requirement." Gmail's examples are password resets, reservation confirmations and form-submission confirmations. "Message recipients, not Google, determine the nature of the messages they receive" [G2].
- **Counting:** volume across subdomains of the same primary domain counts together, and "Bulk sender status doesn't have an expiration date" [G2].

### Yahoo

- **All senders:** SPF or DKIM at minimum. **Bulk senders:** SPF and DKIM, a DMARC policy of at least `p=none` that passes, "a functioning list-unsubscribe header, which supports one-click unsubscribe for marketing and subscribed messages" (RFC 8058 POST is "highly recommended", mailto is acceptable), a visible unsubscribe link in the body, unsubscribes honoured "within 2 days", and a spam rate under 0.3% [Y1].
- Yahoo recommends sending bulk mail from different IPs than transactional mail. Postmark's separate broadcast infrastructure meets this [Y1][P1].
- Yahoo's page does not say explicitly whether transactional mail is exempt. Its unsubscribe rule is worded for "marketing and subscribed messages" only [Y1].

## 3. Does "an Instructor answered your Comment" count as transactional?

**Yes, by Postmark's definition.** Postmark lists "Comment notifications" as transactional [P2], and the email is automatic, one-to-one, and follows the learner's own action of posting a Comment [P3]. Gmail's exemption covers transactional messages, but whether mail is transactional is ultimately judged by recipients' behaviour [G2]. If learners did not expect these emails, they will mark them as spam whatever stream they come from.

Recommendations (my inference):

- Send reply Notifications and refund decisions on the transactional (`outbound`) stream.
- Give learners per-type Notification preferences. On engagement Notifications such as replies and milestones, add a body link plus RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers through the `Headers` array, pointing at an endpoint that turns off that Notification type. Postmark allows this but does not require it on transactional streams [P4]. It costs little and lowers complaints. Refund decisions should have no unsubscribe link.
- Anything batched, scheduled, written by a human or promotional goes on a separate broadcast stream, where Postmark's managed unsubscribe applies [P4].
- Check that the sending domain has SPF, DKIM (2048-bit if possible) and DMARC aligned with From:. Volumes are probably below 5,000 a day for now, but bulk status in Gmail is permanent once reached [G1][G2].

## Open questions and caveats

- `app/lib/mailer.server.ts` was not found in this checkout, so the current sending setup is as the ticket describes it and was not checked.
- Postmark's documents conflict on digests ([P2] says transactional; [P3] leans broadcast).
- No source covers milestone-style engagement Notifications directly. The classification above is inference.
- Not confirmed from a fetched page: that Postmark scopes unsubscribes per stream, and whether Yahoo exempts transactional mail.
- I tried `https://postmarkapp.com/support/article/1202-what-is-the-difference-between-transactional-and-broadcast-messages` and it returned 404. The other sources replaced it.

## Sources

- [P1] Postmark: How to create and send through Message Streams. https://postmarkapp.com/support/article/1207-how-to-create-and-send-through-message-streams
- [P2] Postmark: What types of messages are a good fit for Postmark? https://postmarkapp.com/support/article/1082-what-types-of-messages-are-a-good-fit-for-postmark
- [P3] Postmark: Transactional vs. Broadcast. https://postmarkapp.com/support/article/transactional-vs-broadcast
- [P4] Postmark: How to include a List-Unsubscribe header. https://postmarkapp.com/support/article/1299-how-to-include-a-list-unsubscribe-header
- [P5] Postmark: Managing your own unsubscribe process. https://postmarkapp.com/support/article/managing-your-own-unsubscribe-process
- [G1] Google: Email sender guidelines. https://support.google.com/a/answer/81126
- [G2] Google: Email sender guidelines FAQ. https://support.google.com/a/answer/14229414
- [Y1] Yahoo Sender Hub: Best practices. https://senders.yahooinc.com/best-practices/
- [R1] RFC 8058: Signaling One-Click Functionality for List Email Headers. https://www.rfc-editor.org/rfc/rfc8058
