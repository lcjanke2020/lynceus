import { type CartSummary } from "./api";
import { CartButton } from "./CartButton";
import { type Product } from "./products";

interface ProductCardProps {
  product: Product;
  onCartChange: (cart: CartSummary) => void;
  onError: (message: string | null) => void;
}

export function ProductCard({ product, onCartChange, onError }: ProductCardProps) {
  return (
    <article className="product">
      <h2>{product.name}</h2>
      <p className="price">${(product.priceCents / 100).toFixed(2)}</p>
      <CartButton product={product} onCartChange={onCartChange} onError={onError} />
    </article>
  );
}
