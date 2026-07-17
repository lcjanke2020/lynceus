export interface CartItem {
  id: string;
  name: string;
  qty: number;
}

export interface CartSummary {
  items: CartItem[];
  count: number;
}

export const API_BASE: string =
  import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3001";

export async function fetchCart(): Promise<CartSummary> {
  const res = await fetch(`${API_BASE}/api/cart`);
  if (!res.ok) {
    throw new Error(`GET /api/cart responded ${res.status}`);
  }
  return res.json();
}

export async function postAddToCart(
  id: string,
  name: string,
): Promise<CartSummary> {
  const res = await fetch(`${API_BASE}/api/cart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/cart responded ${res.status}`);
  }
  return res.json();
}
