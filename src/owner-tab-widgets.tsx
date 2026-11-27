import { useState } from 'preact/hooks';
import { mondayOf, type DashboardOrder } from './dashboard-model';
import { OwnerDashboardOverview, type MonthlyWidgetRenderer } from './dashboard-overview';
import { workshopDay } from './workspace-types';

interface OwnerTabWidgetsProps {
  /** Stable owner tab identifier. Each custom tab needs its own identifier. */
  tab: string;
  /** Orders available to this tab's summary, including historical weeks. */
  orders: DashboardOrder[];
  /** Month selection and data stay with the report supplying this widget. */
  renderMonthly?: MonthlyWidgetRenderer;
}

function TabSummary({ tab, orders, renderMonthly }: OwnerTabWidgetsProps) {
  const [week, setWeek] = useState<string | null>(null);
  return <OwnerDashboardOverview tab={tab} orders={orders} weekStart={week ?? mondayOf(workshopDay())} onWeekChange={setWeek}
    renderMonthly={renderMonthly} />;
}

export function OwnerTabWidgets(props: OwnerTabWidgetsProps) {
  return <TabSummary key={props.tab} {...props} />;
}
