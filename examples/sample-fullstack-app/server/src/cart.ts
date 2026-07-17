import { Router } from "express";

export interface CartItem {
  id: string;
  name: string;
  qty: number;
}

// In-memory cart shared by both routes; one cart per server process is
// plenty for a demo fixture.
const items: CartItem[] = [];

function cartSummary(): { items: CartItem[]; count: number } {
  return { items, count: items.reduce((total, item) => total + item.qty, 0) };
}

export const cartRouter = Router();

cartRouter.get("/api/cart", (_req, res) => {
  res.json(cartSummary());
});

cartRouter.post("/api/cart", (req, res) => {
  const body = (req.body ?? {}) as Partial<Pick<CartItem, "id" | "name">>;
  if (typeof body.id === "string" && typeof body.name === "string") {
    const existing = items.find((item) => item.id === body.id);
    if (existing) {
      existing.qty += 1;
    } else {
      items.push({ id: body.id, name: body.name, qty: 1 });
    }
  }
  res.json(cartSummary());
});
