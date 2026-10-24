import "./Badge.css";

/** 档位等状态徽章的变体：outline=描边幽灵款（免费档），solid=浅灰实底款（付费会员档）。 */
export type BadgeVariant = "outline" | "solid";

export interface BadgeProps {
  variant?: BadgeVariant;
  /** 徽章文案由调用方给出（如服务端下发的档位名），组件不解释其语义。 */
  children: string;
}

/** 成熟组件库风格的中性徽章基元：药丸形、小号、不引入新强调色。 */
export function Badge({ variant = "outline", children }: BadgeProps) {
  return <span className={`badge-control badge-control--${variant}`}>{children}</span>;
}
