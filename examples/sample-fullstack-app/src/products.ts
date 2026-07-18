export interface Product {
  id: string;
  name: string;
  priceCents: number;
}

export const PRODUCTS: Product[] = [
  { id: "espresso", name: "Espresso Machine", priceCents: 24900 },
  { id: "grinder", name: "Burr Grinder", priceCents: 8900 },
  { id: "kettle", name: "Gooseneck Kettle", priceCents: 4500 },
];
