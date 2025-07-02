import { type StackProps } from "aws-cdk-lib";
import { CpuArchitecture } from 'aws-cdk-lib/aws-ecs';

export interface PipelineProps {
  /**
   * Enable pipeline mode with Github Access Token stored as a secret in SSM Secret Manager.
   * Provide the ARN to your Secrets Manager secret.
   */
  readonly accessTokenSecretArn?: string;

  /**
   * Configure your Github repository
   */
  readonly sourceProps?: {
    readonly owner?: string;
    readonly repo?: string;
    readonly branchOrRef?: string;
  };

  /**
   * The properties for CodeBuild build process.
   */
  readonly buildProps?: {
    readonly environment?: Array<{ [key: string]: string; }>;
    readonly secrets?: { key: string; resource: string; }[];
  };

  /**
   * If you have a custom buildspec.yml file for your app, provide the relative path to the file.
   */
  readonly buildSpecFilePath?: string;

  /**
   * The ARN of the Event Bus.
   * - The pipeline events are broadcast to an event bus. Defaults to null.
   */
  readonly eventTarget?: string;
}

/**
 * ECS Fargate properties 
 */
export interface ServiceProps {
  readonly architecture?: CpuArchitecture;
  readonly desiredCount?: number;
  readonly cpu?: number;
  readonly memorySize?: number;
  readonly port?: number;
  readonly variables?: Array<{ [key: string]: string; }>;
  readonly secrets?: { key: string; resource: string; }[];
  readonly dockerFile?: string;
  readonly dockerBuildArgs?: string[];
}

/**
 * Domain and certificate properties
 */
export interface DomainProps {
  /**
   * Optional. The domain (without the protocol) at which the app shall be publicly available.
   */
  readonly domain?: string;
  /**
   * Optional. The ARN of the certificate to use on CloudFront for the app to make it accessible via HTTPS.
   */
  readonly globalCertificateArn?: string;
  /**
   * Optional. The ARN of the certificate to use for API Gateway for the app to make it accessible via HTTPS.
   */
  readonly regionalCertificateArn?: string;
  /**
   * Optional. The ID of the hosted zone to create a DNS record for the specified domain.
   */
  readonly hostedZoneId?: string;
}

/**
 * AWS CloudFront properties
 */
export interface CloudFrontProps {
  /**
   * Optional. The path to the error page in the output directory. e.g. /404.html
   * Relative to the output directory.
   */
  readonly errorPagePath?: string;

  /**
   * Optional. An array of headers to include in the cache key and pass to the origin on requests.
   * No headers are passed by default.
   */
  readonly allowHeaders?: string[];

  /**
   * Optional. An array of cookies to include in the cache key and pass to the origin on requests.
   * No cookies are passed by default.
   */
  readonly allowCookies?: string[];

  /**
   * Optional. An array of query parameter keys to include in the cache key and pass to the origin on requests.
   * No query parameters are passed by default.
   * You have specific query parameters that alter the content (e.g., ?userId=, ?lang=, etc.).
   * You want to cache different versions of the content based on these parameters.
   */
  readonly allowQueryParams?: string[];

  /**
   * Optional. An array of query param keys to deny passing to the origin on requests.
   * You have query parameters that should be ignored for caching purposes (e.g., tracking parameters like ?utm_source= or ?fbclid=).
   * You want to prevent these parameters from affecting cache performance.
   * Note that this config can not be combined with {@see allowQueryParams}.
   * If both are specified, the {@see denyQueryParams} will be ignored.
   */
  readonly denyQueryParams?: string[];
}

/**
 * Application identity and environment properties
 */
export interface AppProps extends StackProps {
  /**
   * Debug
   */
  readonly debug?: boolean;

  /**
   * The AWS environment (account/region) where this stack will be deployed.
   */
  readonly env: {
    // The ID of your AWS account on which to deploy the stack.
    readonly account: string;

    // The AWS region where to deploy the app.
    readonly region: string;
  };

  /**
   * A string identifier for the project the app is part of.
   */
  readonly application: string;

  /**
   * A string identifier for the project's service the app is created for.
   */
  readonly service: string;

  /**
   * A string to identify the environment of the app.
   */
  readonly environment: string;

  /**
   * The path to the root directory of your application.
   * Defaults to '.'
   */
  readonly rootDir?: string;

  /**
   * The output directory of the app.
   * This is the directory where the app's build output is located.
   * It is relative to the root directory.
   */
  readonly outputDir?: string;
}

// Main WebServiceProps interface
export interface WebServiceProps
  extends PipelineProps,
    DomainProps,
    CloudFrontProps,
    AppProps {
      readonly serviceProps?: ServiceProps;
    }