export function Header({ count }: { count: number }) {
  return (
    <header>
      <h1>lynceus outfitters</h1>
      <CartBadge count={count} />
    </header>
  );
}

function CartBadge({ count }: { count: number }) {
  return (
    <span id="cart-count" role="status">
      cart: {count}
    </span>
  );
}
