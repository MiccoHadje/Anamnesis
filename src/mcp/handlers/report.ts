import { getConfig } from '../../util/config.js';
import { createTaskProvider } from '../../tasks/index.js';
import { generateProjectReport, generateCrossProjectReport } from '../daily-report.js';

export async function handleDailyReport(args: Record<string, unknown>): Promise<string> {
  const config = getConfig();
  if (!config.reporting?.projects?.length) {
    return 'Error: No reporting.projects configured in anamnesis.config.json. Add a "reporting" section with your projects to use daily reports.';
  }

  // Default to yesterday
  const dateArg = args.date as string | undefined;
  const date = dateArg || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  // Create task provider (optional — null if not configured)
  const taskProvider = createTaskProvider(config);

  try {
    const projectName = args.project as string | undefined;

    if (projectName) {
      // Find matching project in config
      const proj = config.reporting.projects.find(
        p => p.name.toLowerCase() === projectName.toLowerCase() ||
             p.anamnesis_project.toLowerCase() === projectName.toLowerCase()
      );
      if (!proj) {
        const available = config.reporting.projects.map(p => p.name).join(', ');
        return `Error: Project "${projectName}" not found in reporting config. Available: ${available}`;
      }
      const report = await generateProjectReport(date, proj.name, proj.anamnesis_project, taskProvider ?? undefined, proj.nudge_project);
      return report || `No activity found for ${proj.name} on ${date}.`;
    }

    // Cross-project report
    const report = await generateCrossProjectReport(date, config.reporting.projects, taskProvider ?? undefined);
    return report;
  } finally {
    await taskProvider?.close?.();
  }
}
