import { useCallback, useEffect, useState } from "react";

type Ticket = {
  id: string;
  message_id: string;
  original_text: string;
  status: string;
  rejection_reason: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  classification_status: string | null;
  classification_category: string | null;
  classification_attempts: number | null;
  classification_llm_calls: number | null;
  classification_started_at: string | null;
  classification_completed_at: string | null;
  classification_error: string | null;
  extraction_status: string | null;
  order_id: string | null;
  product: string | null;
  urgency: string | null;
  requested_action: string | null;
  extraction_attempts: number | null;
  extraction_llm_calls: number | null;
  extraction_started_at: string | null;
  extraction_completed_at: string | null;
  extraction_error: string | null;
};

type Event = {
  id: string;
  message_id: string | null;
  event_type: string;
  reason: string | null;
  created_at: string;
};

type Operations = Record<string, number | boolean> & { llm_configured: boolean };
const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";
const pageSize = 10;

function timestamp(value: string) {
  return new Date(value).toLocaleString();
}

export function App() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [summary, setSummary] = useState<Operations>({ llm_configured: false });
  const [page, setPage] = useState(1);
  const [health, setHealth] = useState("Connecting");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [ticketResponse, eventResponse, summaryResponse, healthResponse] = await Promise.all([
        fetch(`${apiBase}/api/v1/tickets?page=${page}&limit=${pageSize}`),
        fetch(`${apiBase}/api/v1/ops/events?limit=20`),
        fetch(`${apiBase}/api/v1/ops/summary`),
        fetch(`${apiBase}/health/ready`),
      ]);
      if (!ticketResponse.ok || !eventResponse.ok || !summaryResponse.ok) {
        throw new Error("The API returned an error while loading operational data.");
      }
      const [ticketData, eventData, summaryData] = await Promise.all([
        ticketResponse.json(),
        eventResponse.json(),
        summaryResponse.json(),
      ]);
      setTickets(ticketData.tickets as Ticket[]);
      setEvents(eventData.events as Event[]);
      setSummary(summaryData as Operations);
      setHealth(healthResponse.ok ? "API and database ready" : "Database unavailable");
      setError("");
    } catch (reason) {
      setHealth("Disconnected");
      setError(reason instanceof Error ? reason.message : "Could not connect to the API.");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">PROJECT KESTREL · INGESTION</p>
          <h1>Kestrel Ticket Desk</h1>
        </div>
        <div className={`health ${health === "API and database ready" ? "healthy" : "unhealthy"}`}>
          <span className="health-dot" /> {health}
        </div>
      </header>

      {error && <p className="alert" role="alert">{error} Retrying automatically.</p>}

      <section className="metrics" aria-label="Operational counters">
        {[
          ["Valid tickets", "valid_tickets_received"],
          ["Pending", "pending"],
          ["Processing", "processing"],
          ["Completed", "completed"],
          ["Failed", "failed"],
          ["Rejected", "rejected_tickets"],
          ["Duplicates", "duplicate_submissions"],
          ["Conflicts", "payload_conflicts"],
          ["Ingestion errors", "ingestion_errors"],
          ["Classify pending", "classification_pending"],
          ["Classifying", "classification_in_progress"],
          ["Classified", "classification_completed"],
          ["Classification failed", "classification_failed"],
          ["LLM calls", "classification_calls"],
          ["LLM retries", "classification_retries"],
          ["Extract pending", "extraction_pending"],
          ["Extracting", "extraction_in_progress"],
          ["Extracted", "extraction_completed"],
          ["Extraction failed", "extraction_failed"],
          ["Extraction calls", "extraction_calls"],
          ["Extraction retries", "extraction_retries"],
        ].map(([label, key]) => (
          <article className="metric" key={key}>
            <span>{label}</span>
            <strong>{summary[key] ?? "—"}</strong>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">DURABLE DATABASE RECORDS</p>
            <h2>Tickets</h2>
          </div>
          <div className="pagination">
            <button disabled={page === 1} onClick={() => setPage((current) => current - 1)}>Previous</button>
            <span>Page {page}</span>
            <button disabled={tickets.length < pageSize} onClick={() => setPage((current) => current + 1)}>Next</button>
          </div>
        </div>
        {loading && tickets.length === 0 ? <p>Loading tickets…</p> :
          tickets.length === 0 ? <p className="muted">No tickets received yet.</p> : (
            <div className="ticket-list">
              {tickets.map((ticket) => (
                <article className="ticket" key={ticket.id}>
                  <div className="ticket-heading">
                    <strong>{ticket.message_id}</strong>
                    <span className={`badge ${ticket.status}`}>{ticket.status}</span>
                  </div>
                  <p className="ticket-text">{ticket.original_text || <span className="muted">[empty message]</span>}</p>
                  {(ticket.rejection_reason || ticket.last_error) &&
                    <p className="reason">{ticket.rejection_reason ?? ticket.last_error}</p>}
                  {ticket.status !== "rejected" && (
                    <>
                    <div className="classification">
                      <span>
                        Classification: <strong>{ticket.classification_status ?? "not queued"}</strong>
                      </span>
                      {ticket.classification_category && (
                        <span>Category: <strong>{ticket.classification_category}</strong></span>
                      )}
                      {ticket.classification_attempts !== null && (
                        <span>
                          Attempts {ticket.classification_attempts}
                          {ticket.classification_llm_calls !== null &&
                            ` · LLM calls ${ticket.classification_llm_calls}`}
                        </span>
                      )}
                      {ticket.classification_error && (
                        <p className="reason">{ticket.classification_error}</p>
                      )}
                      {ticket.classification_completed_at && (
                        <span>Classified {timestamp(ticket.classification_completed_at)}</span>
                      )}
                    </div>
                    <div className="extraction">
                      <div className="extraction-heading">
                        <strong>Extraction</strong>
                        <span className={`badge ${ticket.extraction_status ?? "pending"}`}>
                          {ticket.extraction_status ?? "not queued"}
                        </span>
                      </div>
                      <div className="extraction-fields">
                        <span>Order ID: <strong>{ticket.order_id ?? "Not provided"}</strong></span>
                        <span>Product: <strong>{ticket.product ?? "Not provided"}</strong></span>
                        <span>Urgency: <strong>{ticket.urgency ?? "Not available"}</strong></span>
                        <span>Requested action: <strong>{ticket.requested_action ?? "No clear action"}</strong></span>
                        {ticket.extraction_attempts !== null && (
                          <span>
                            Attempts {ticket.extraction_attempts}
                            {ticket.extraction_llm_calls !== null &&
                              ` · LLM calls ${ticket.extraction_llm_calls}`}
                          </span>
                        )}
                        {ticket.extraction_started_at && (
                          <span>Started {timestamp(ticket.extraction_started_at)}</span>
                        )}
                        {ticket.extraction_completed_at && (
                          <span>Extracted {timestamp(ticket.extraction_completed_at)}</span>
                        )}
                      </div>
                      {ticket.extraction_error && (
                        <p className="reason">{ticket.extraction_error}</p>
                      )}
                    </div>
                    </>
                  )}
                  <div className="ticket-meta">
                    <span>Received {timestamp(ticket.created_at)}</span>
                    <span>Updated {timestamp(ticket.updated_at)}</span>
                    <span>Attempts {ticket.attempts}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">LATEST ACTIVITY</p>
            <h2>Ingestion events</h2>
          </div>
          <span className="muted">Refreshes every 5 seconds</span>
        </div>
        {events.length === 0 ? <p className="muted">No ingestion events yet.</p> : (
          <div className="event-list">
            {events.map((event) => (
              <article className="event" key={event.id}>
                <strong>{event.event_type.replaceAll("_", " ")}</strong>
                <span>{event.message_id ?? "No message ID"}</span>
                <span>{event.reason ?? "—"}</span>
                <time>{timestamp(event.created_at)}</time>
              </article>
            ))}
          </div>
        )}
      </section>
      <p className="muted llm-status">
        LLM endpoint: {summary.llm_configured ? "configured (availability is checked during classification)" : "not configured"}
      </p>
    </main>
  );
}
