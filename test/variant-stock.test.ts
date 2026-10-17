import assert from "node:assert/strict";
import test from "node:test";

import { PubkyShopClient, type VariantStockView } from "../src/index.js";
import { SELLER_PUBKY } from "./helpers.js";

// Spec-derived: built from the marketplace service wire for per-variant stock
// (pubky-marketplace-service PR #138), not from a capture. Replace with a
// captured fixture when one exists.

const AGGREGATE = `listing:${SELLER_PUBKY}_shirt_01`;
const EVENT = "00000000-0000-4000-8000-000000000002";
const KEY = "00000000-0000-4000-8000-000000000001";

const LISTING_TOTAL = { authority: "listing_total", total: 5, available: 4, reserved: 1, sold: 0 };

function variantStock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authority: "variant",
    variant_id: "size_m",
    sku: "SHIRT-M",
    total: 4,
    available: 3,
    reserved: 1,
    sold: 0,
    listing_total: LISTING_TOTAL,
    ...overrides,
  };
}

function adjustBody(stock: unknown): string {
  return JSON.stringify({
    ok: true,
    result: {
      aggregate_id: AGGREGATE,
      event_id: EVENT,
      listing_id: "shirt_01",
      server_revision: 7,
      stock,
    },
    schema_version: 1,
  });
}

function projectionBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    aggregate_id: AGGREGATE,
    kind: "inventory_projection",
    listing_id: "shirt_01",
    schema_version: 1,
    seller_pubky: SELLER_PUBKY,
    server_revision: 7,
    stock: LISTING_TOTAL,
    ...extra,
  });
}

function clientFor(body: string, onRequest?: (init: RequestInit | undefined) => void) {
  return new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async (_input, init) => {
      onRequest?.(init);
      return new Response(body, { status: 200 });
    },
  });
}

async function adjust(client: PubkyShopClient, variant?: { id?: string; sku?: string }) {
  return client.adjustInventory({
    schema_version: 1,
    kind: "inventory.adjust",
    aggregate_id: AGGREGATE,
    listing_id: "shirt_01",
    expected_revision: 6n,
    delta: -1n,
    idempotency_key: KEY,
    ...(variant === undefined ? {} : { variant }),
  });
}

test("spec-derived: adjust answered with authority variant decodes and keeps listing_total", async () => {
  const result = await adjust(clientFor(adjustBody(variantStock())), { id: "size_m" });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const stock = result.value.result.stock;
  assert.equal(stock.authority, "variant");
  const variant = stock as VariantStockView;
  assert.equal(variant.variant_id, "size_m");
  assert.equal(variant.sku, "SHIRT-M");
  assert.equal(variant.available, 3n);
  assert.equal(variant.listing_total.authority, "listing_total");
  assert.equal(variant.listing_total.available, 4n);
  assert.equal(result.value.result.server_revision, 7n);
});

test("spec-derived: variant stock without a sku decodes", async () => {
  const { sku: _sku, ...noSku } = variantStock();
  const result = await adjust(clientFor(adjustBody(noSku)), { id: "size_m" });
  assert.equal(result.ok, true);
});

test("spec-derived: listing_total adjust answer is unchanged", async () => {
  const result = await adjust(clientFor(adjustBody(LISTING_TOTAL)));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.result.stock.authority, "listing_total");
  }
});

test("spec-derived: malformed variant stock is invalid_response", async () => {
  const bad: Record<string, unknown>[] = [
    variantStock({ variant_id: undefined }),
    variantStock({ variant_id: "" }),
    variantStock({ sku: 5 }),
    variantStock({ total: 5 }),
    variantStock({ available: -1, total: 0 }),
    variantStock({ listing_total: undefined }),
    variantStock({ listing_total: { ...LISTING_TOTAL, authority: "variant" } }),
    variantStock({ listing_total: { ...LISTING_TOTAL, total: 9 } }),
    variantStock({ authority: "other" }),
  ];
  for (const stock of bad) {
    const result = await adjust(clientFor(adjustBody(stock)), { id: "size_m" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_response");
    }
  }
});

test("spec-derived: variant selector (id, sku, or both) is sent unchanged", async () => {
  for (const variant of [{ id: "size_m" }, { sku: "SHIRT-M" }, { id: "size_m", sku: "SHIRT-M" }]) {
    let posted: unknown;
    const result = await adjust(
      clientFor(adjustBody(variantStock()), (init) => {
        posted = JSON.parse(String(init?.body));
      }),
      variant,
    );
    assert.equal(result.ok, true);
    assert.deepEqual((posted as { variant: unknown }).variant, variant);
  }
});

test("spec-derived: empty or unknown variant selector keys still fail validation", async () => {
  for (const variant of [{}, { id: "size_m", extra: "x" }]) {
    const result = await adjust(
      clientFor(adjustBody(variantStock())),
      variant as { id?: string; sku?: string },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "validation_failed");
    }
  }
});

test("spec-derived: inventory read decodes variants", async () => {
  const variants = [
    {
      variant_id: "size_s",
      sku: "SHIRT-S",
      enabled: true,
      total: 1,
      available: 0,
      reserved: 0,
      sold: 1,
      sold_out: true,
    },
    {
      variant_id: "size_m",
      enabled: true,
      total: 4,
      available: 3,
      reserved: 1,
      sold: 0,
      sold_out: false,
    },
  ];
  const result = await clientFor(projectionBody({ variants })).getInventoryProjection(AGGREGATE);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.stock.authority, "listing_total");
  assert.equal(result.value.variants?.length, 2);
  assert.equal(result.value.variants?.[0]?.sold_out, true);
  assert.equal(result.value.variants?.[1]?.available, 3n);
  assert.equal(result.value.variants?.[1]?.sku, undefined);
});

test("spec-derived: inventory read without variants is unchanged", async () => {
  const result = await clientFor(projectionBody()).getInventoryProjection(AGGREGATE);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.variants, undefined);
  }
});

test("spec-derived: malformed variants on the inventory read are invalid_response", async () => {
  const row = {
    variant_id: "size_m",
    enabled: true,
    total: 4,
    available: 3,
    reserved: 1,
    sold: 0,
    sold_out: false,
  };
  const bad: unknown[] = [
    "size_m",
    [{ ...row, enabled: "yes" }],
    [{ ...row, sold_out: undefined }],
    [{ ...row, total: 9 }],
    [{ ...row, variant_id: undefined }],
    [null],
  ];
  for (const variants of bad) {
    const result = await clientFor(projectionBody({ variants })).getInventoryProjection(AGGREGATE);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_response");
    }
  }
});

// Spec-derived from the service wire for made-to-order stock
// (pubky-marketplace-service migration 0073): `made_to_order` appears only
// when true, with nothing counted as available.

test("spec-derived: made-to-order stock decodes on the inventory read", async () => {
  const stock = {
    ...LISTING_TOTAL,
    total: 3,
    available: 0,
    reserved: 1,
    sold: 2,
    made_to_order: true,
  };
  const variants = [
    {
      variant_id: "size_m",
      enabled: true,
      total: 3,
      available: 0,
      reserved: 1,
      sold: 2,
      sold_out: false,
      made_to_order: true,
    },
  ];
  const result = await clientFor(projectionBody({ stock, variants })).getInventoryProjection(
    AGGREGATE,
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.stock.made_to_order, true);
  assert.equal(result.value.stock.available, 0n);
  assert.equal(result.value.variants?.[0]?.made_to_order, true);
  assert.equal(result.value.variants?.[0]?.sold_out, false);
});

test("spec-derived: a listing with one made-to-order size still counts its other sizes", async () => {
  const stock = {
    ...LISTING_TOTAL,
    total: 4,
    available: 3,
    reserved: 0,
    sold: 1,
    made_to_order: true,
  };
  const variants = [
    {
      variant_id: "size_s",
      enabled: true,
      total: 3,
      available: 3,
      reserved: 0,
      sold: 0,
      sold_out: false,
    },
    {
      variant_id: "size_m",
      enabled: true,
      total: 1,
      available: 0,
      reserved: 0,
      sold: 1,
      sold_out: false,
      made_to_order: true,
    },
  ];
  const result = await clientFor(projectionBody({ stock, variants })).getInventoryProjection(
    AGGREGATE,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.stock.available, 3n);
    assert.equal(result.value.stock.made_to_order, true);
    assert.equal(result.value.variants?.[0]?.made_to_order, undefined);
  }
});

test("spec-derived: a made-to-order size that counts units or reads sold out is invalid_response", async () => {
  const row = {
    variant_id: "size_m",
    enabled: true,
    total: 1,
    available: 0,
    reserved: 0,
    sold: 1,
    sold_out: false,
    made_to_order: true,
  };
  const bad = [
    projectionBody({ stock: { ...LISTING_TOTAL, made_to_order: "yes" } }),
    projectionBody({ variants: [{ ...row, sold_out: true }] }),
    projectionBody({ variants: [{ ...row, total: 2, available: 1 }] }),
    projectionBody({ variants: [{ ...row, made_to_order: 1 }] }),
  ];
  for (const body of bad) {
    const result = await clientFor(body).getInventoryProjection(AGGREGATE);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_response");
    }
  }
});

test("spec-derived: an adjustment of made-to-order stock names stock_not_tracked", async () => {
  const client = new PubkyShopClient({
    session: "opaque-host-bearer",
    serviceUrl: "https://inventory.example/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          schema_version: 1,
          ok: false,
          error: {
            code: "stock_not_tracked",
            message: "The stock is made to order and has no count to adjust.",
            current_revision: 7,
          },
        }),
        { status: 409 },
      ),
  });
  const result = await adjust(client);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.details.serviceCode, "stock_not_tracked");
  }
});
