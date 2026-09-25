import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { Select } from './ui/input';

/** The selected project slug lives in `?project=` so a filtered view can be linked; empty means every project. */
export const useProjectParam = (): [string, (slug: string) => void] => {
  const [params, setParams] = useSearchParams();
  const setProject = (slug: string) => {
    const next = new URLSearchParams(params);
    if (slug) next.set('project', slug);
    else next.delete('project');
    setParams(next);
  };
  return [params.get('project') ?? '', setProject];
};

export const ProjectFilter = ({ value, onChange }: { value: string; onChange: (slug: string) => void }) => {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  return (
    <Select aria-label="Project" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All projects</option>
      {projects.data?.map((project) => (
        <option key={project.id} value={project.slug}>
          {project.name}
        </option>
      ))}
    </Select>
  );
};
