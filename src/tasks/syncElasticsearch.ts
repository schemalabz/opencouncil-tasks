import { z } from 'zod';
import { Task } from './pipeline.js';
import { SyncElasticsearchRequest, SyncElasticsearchResult } from '../types.js';

const ELASTICSEARCH_HOST = process.env.ELASTICSEARCH_HOST;
const ELASTICSEARCH_API_KEY = process.env.ELASTICSEARCH_API_KEY;
const ELASTICSEARCH_CONNECTOR_ID = process.env.ELASTICSEARCH_CONNECTOR_ID;

const POLL_INTERVAL_MS = 10000; // 10 seconds
const MAX_POLLING_ATTEMPTS = 90; // 15 minutes (90 attempts * 10 seconds)
const MAX_PENDING_ATTEMPTS = 12; // 2 minutes (12 attempts * 10 seconds)

// Progress reporting constants
const PROGRESS_STARTING = 10;
const PROGRESS_JOB_STARTED = 25;
const PROGRESS_COMPLETED = 100;
const PROGRESS_INCREMENT_MAX = 70;

const SyncElasticsearchPayload = z.object({
  job_type: z.enum(['full', 'incremental', 'access_control']).default('full'),
  trigger_method: z.enum(['on_demand', 'scheduled']).optional(),
});

const makeRequest = async (path: string, options: RequestInit = {}) => {
  if (!ELASTICSEARCH_HOST || !ELASTICSEARCH_API_KEY || !ELASTICSEARCH_CONNECTOR_ID) {
    throw new Error('ELASTICSEARCH_HOST, ELASTICSEARCH_API_KEY and ELASTICSEARCH_CONNECTOR_ID must be set');
  }

  const url = `${ELASTICSEARCH_HOST}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `ApiKey ${ELASTICSEARCH_API_KEY}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Elasticsearch API error: ${response.status} ${response.statusText} - ${errorBody}`);
    throw new Error(`Elasticsearch API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
};

const startSyncJob = async (job_type: 'full' | 'incremental' | 'access_control', trigger_method?: 'on_demand' | 'scheduled'): Promise<{ id: string }> => {
    console.log(`Starting new sync job of type: ${job_type}`);
    return makeRequest('/_connector/_sync_job', {
      method: 'POST',
      body: JSON.stringify({
        id: ELASTICSEARCH_CONNECTOR_ID,
        job_type,
        trigger_method,
      }),
    });
  };

const getSyncJobStatus = async (jobId: string): Promise<SyncElasticsearchResult> => {
    const rawResponse = await makeRequest(`/_connector/_sync_job/${jobId}`);
    // the full response contains fields with sensitive data, so we need to filter them out
    const filteredResponse: SyncElasticsearchResult = {
      id: rawResponse.id,
      status: rawResponse.status,
      job_type: rawResponse.job_type,
      trigger_method: rawResponse.trigger_method,
      error: rawResponse.error,
      created_at: rawResponse.created_at,
      started_at: rawResponse.started_at,
      last_seen: rawResponse.last_seen,
      completed_at: rawResponse.completed_at,
      total_document_count: rawResponse.total_document_count,
      indexed_document_count: rawResponse.indexed_document_count,
      deleted_document_count: rawResponse.deleted_document_count,
    };
    return filteredResponse;
};

export const syncElasticsearch: Task<SyncElasticsearchRequest, SyncElasticsearchResult> = async (payload, onProgress) => {
    const { job_type, trigger_method } = SyncElasticsearchPayload.parse(payload);
    onProgress('starting', PROGRESS_STARTING);

    const syncJob = await startSyncJob(job_type, trigger_method);
    onProgress(`Job ${syncJob.id} started`, PROGRESS_JOB_STARTED);

    // Immediately check the status of the job
    let job = await getSyncJobStatus(syncJob.id);
    if (job.status === 'error') {
      throw new Error(`Sync job failed immediately with error: ${job.error}`);
    }

    let attempts = 0;
    let pendingAttempts = 0;

    do {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      job = await getSyncJobStatus(syncJob.id);

      if (job.status === 'pending') {
        pendingAttempts++;
        if (pendingAttempts >= MAX_PENDING_ATTEMPTS) {
          throw new Error('Sync job has been pending for too long. The connector might be down.');
        }
      } else {
        pendingAttempts = 0;
      }
      
      const progress = PROGRESS_JOB_STARTED + Math.round((attempts / MAX_POLLING_ATTEMPTS) * PROGRESS_INCREMENT_MAX);
      onProgress(`Job status: ${job.status}`, progress);

      attempts++;
    } while (['pending', 'in_progress'].includes(job.status) && attempts < MAX_POLLING_ATTEMPTS);

    if (job.status === 'completed') {
        onProgress('completed', PROGRESS_COMPLETED);
        return job;
    } else if (job.status === 'error') {
        throw new Error(`Sync job failed with error: ${job.error}`);
    } else if (attempts >= MAX_POLLING_ATTEMPTS) {
        throw new Error('Sync job timed out.');
    } else {
        throw new Error(`Sync job ended with unexpected status: ${job.status}`);
    }
}; 