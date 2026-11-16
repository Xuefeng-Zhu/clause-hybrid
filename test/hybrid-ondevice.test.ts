import { describe, expect, it } from "vitest";
import { stripNulls, toOnDeviceJsonSchema, toModelJsonSchema } from "../app/lib/hybrid-ai.js";
import { renumberDuplicateMilestoneIds } from "../app/lib/clause-ai/parse.js";
import { ContractTerms } from "../server/clause/contract/schema.js";

describe("on-device schema tightening", () => {
  it("makes optional top-level fields required but nullable", () => {
    const s = toOnDeviceJsonSchema(toModelJsonSchema(ContractTerms)) as any;
    expect(s.required).toContain("prohibited_spend");
    expect(s.required).toContain("change_order_clause");
    expect(s.properties.start_date.anyOf[1]).toEqual({ type: "null" });
    expect(s.properties.total_amount.anyOf).toBeUndefined();
  });
  it("strips nulls so absent fields parse", () => {
    expect(stripNulls({ a: null, b: [{ c: null, d: 1 }] })).toEqual({ b: [{ d: 1 }] });
  });
  it("renumbers duplicate milestone ids without touching amounts", () => {
    const t: any = { milestones: [{ id: "M1", amount: 4000 }, { id: "M1", amount: 8000 }] };
    renumberDuplicateMilestoneIds(t);
    expect(t.milestones.map((m: any) => m.id)).toEqual(["M1", "M2"]);
    expect(t.milestones.map((m: any) => m.amount)).toEqual([4000, 8000]);
  });
});
