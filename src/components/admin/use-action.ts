'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { FormProblem } from '@/components/auth/form-message';
import { apiProblem } from '@/lib/api-problem';
import { sendJSON } from '@/lib/post-json';

/** Runs an API mutation; on success shows `message` and refreshes server data, else t(error). */
export function useAction() {
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    message: string,
  ): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const res = await sendJSON(method, path, body);
    setBusy(false);
    if (res.status >= 200 && res.status < 300) {
      setNotice(message);
      router.refresh();
      return true;
    }
    setProblem(apiProblem(res, tErrors));
    return false;
  }

  return { run, problem, notice, busy };
}
