import { postAddToCart, type CartSummary } from "./api";
import { type Product } from "./products";

interface CartButtonProps {
  product: Product;
  onCartChange: (cart: CartSummary) => void;
  onError: (message: string | null) => void;
}

export function CartButton({ product, onCartChange, onError }: CartButtonProps) {
  async function handleAddToCart() {
    try {
      // DEMO.md sets the browser-side breakpoint on the next line — if you
      // edit this file, update the line number cited there.
      const updated = await postAddToCart(product.id, product.name);
      onCartChange(updated);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <button id={`add-${product.id}`} onClick={() => void handleAddToCart()}>
      Add to cart
    </button>
  );
}
