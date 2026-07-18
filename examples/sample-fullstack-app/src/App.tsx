import { useEffect, useState } from "react";
import { fetchCart, type CartSummary } from "./api";
import { Header } from "./Header";
import { ProductCard } from "./ProductCard";
import { PRODUCTS } from "./products";

const EMPTY_CART: CartSummary = { items: [], count: 0 };

export function App() {
  const [cart, setCart] = useState<CartSummary>(EMPTY_CART);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    fetchCart()
      .then((current) => {
        setCart(current);
        setApiError(null);
      })
      .catch((err: unknown) => {
        setApiError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <main>
      <Header count={cart.count} />
      {apiError !== null && (
        <p id="api-error" role="alert">
          backend unreachable — {apiError}
        </p>
      )}
      <section id="products">
        {PRODUCTS.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            onCartChange={setCart}
            onError={setApiError}
          />
        ))}
      </section>
    </main>
  );
}
