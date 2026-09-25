import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

export const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <Card>
    <CardHeader className="pb-1">
      <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
    </CardHeader>
    <CardContent className="text-2xl font-semibold tabular-nums">{value}</CardContent>
  </Card>
);
