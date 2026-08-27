import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/preact";
import { Insights, CredentialHealthSection, formatCurrency } from "../src/components/Insights";
import type { Insights as InsightsData, InsightTile } from "../src/types";

const NOT_CONNECTED: InsightTile<never> = { status: "not_connected" };
const ERROR: InsightTile<never> = { status: "error", message: "boom" };

function baseInsights(overrides: Partial<InsightsData> = {}): InsightsData {
  return {
    personalUnread: NOT_CONNECTED,
    workUnread: NOT_CONNECTED,
    azureCost: NOT_CONNECTED,
    credentialHealth: NOT_CONNECTED,
    scriptRunHistory: NOT_CONNECTED,
    usageWaste: NOT_CONNECTED,
    ...overrides,
  };
}

describe("formatCurrency", () => {
  it("formats a known currency code with no decimal places", () => {
    expect(formatCurrency(1234.56, "USD")).toBe("$1,235");
  });

  it("falls back to '<CODE> <amount>' for a currency code Intl doesn't recognize", () => {
    // Intl.NumberFormat throws a RangeError on an invalid ISO 4217 code —
    // this is the try/catch fallback branch, not the happy path above.
    expect(formatCurrency(42, "NOTACODE")).toBe("NOTACODE 42");
  });
});

describe("Tile status branching (via the tiles that wrap it)", () => {
  it("renders 'not connected' for a not_connected tile", () => {
    render(<Insights data={baseInsights({ personalUnread: NOT_CONNECTED })} />);
    expect(screen.getAllByText("not connected").length).toBeGreaterThan(0);
  });

  it("renders 'unavailable' (with the error message as a title) for an error tile", () => {
    render(<Insights data={baseInsights({ personalUnread: ERROR })} />);
    const el = screen.getAllByText("unavailable")[0]!;
    expect(el.getAttribute("title")).toBe("boom");
  });

  it("renders the ok-state data for an ok tile", () => {
    render(
      <Insights
        data={baseInsights({
          personalUnread: { status: "ok", data: { unreadCount: 7, totalCount: 40 } },
        })}
      />,
    );
    expect(screen.getByText("7")).not.toBeNull();
  });
});

describe("ScriptRunHistoryTile", () => {
  it("shows the empty state when there are no runs at all", () => {
    render(
      <Insights
        data={baseInsights({
          scriptRunHistory: { status: "ok", data: { applied: 0, failed: 0, pending: 0, rejected: 0 } },
        })}
      />,
    );
    expect(screen.getByText("no runs yet")).not.toBeNull();
  });

  it("does not show the empty state once at least one run is counted", () => {
    render(
      <Insights
        data={baseInsights({
          scriptRunHistory: { status: "ok", data: { applied: 3, failed: 0, pending: 0, rejected: 0 } },
        })}
      />,
    );
    expect(screen.queryByText("no runs yet")).toBeNull();
    expect(screen.getByText("Applied")).not.toBeNull();
  });
});

describe("CredentialHealthSection", () => {
  it("renders nothing when the tile isn't ok (not_connected/error)", () => {
    const { container } = render(<CredentialHealthSection tile={NOT_CONNECTED} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the all-valid summary line when atRisk is empty", () => {
    render(<CredentialHealthSection tile={{ status: "ok", data: { totalTracked: 5, atRisk: [] } }} />);
    expect(screen.getByText(/all 5 tracked credentials valid/)).not.toBeNull();
    // The at-risk list heading must not appear alongside the all-valid summary.
    expect(screen.queryByText("Credential Health")).toBeNull();
  });

  it("lists at-risk credentials instead of the summary line when atRisk is non-empty", () => {
    render(
      <CredentialHealthSection
        tile={{
          status: "ok",
          data: {
            totalTracked: 3,
            atRisk: [{ credentialRef: "nzb-m365-connector", status: "expiring_soon", daysRemaining: 4 }],
          },
        }}
      />,
    );
    expect(screen.getByText("Credential Health")).not.toBeNull();
    expect(screen.getByText("nzb-m365-connector")).not.toBeNull();
    expect(screen.getByText("4d left")).not.toBeNull();
    expect(screen.queryByText(/all 3 tracked credentials valid/)).toBeNull();
  });

  it("renders 'expired' instead of a day count once daysRemaining goes negative", () => {
    render(
      <CredentialHealthSection
        tile={{
          status: "ok",
          data: {
            totalTracked: 1,
            atRisk: [{ credentialRef: "hotmail-oauth", status: "invalid", daysRemaining: -2 }],
          },
        }}
      />,
    );
    expect(screen.getByText("expired")).not.toBeNull();
  });
});
